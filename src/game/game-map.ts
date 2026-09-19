import {
  Map as MapboxMap,
  AttributionControl,
  NavigationControl,
  Marker,
  type ExpressionSpecification,
  type GeoJSONSource,
  type PaddingOptions,
  type PointLike,
} from 'mapbox-gl/esm';
import 'mapbox-gl/dist/mapbox-gl.css';

import { LINES, LINE_ORDER, type LineId } from '../data/lines';
import { ALL_FEATURES, network, stationById, type LngLat } from '../data/network';
import { clamp, easeInOut, easeTrain, prefersReducedMotion } from '../lib/motion';
import { afterVisibleTime } from '../lib/visible-time';
import { applyToken } from '../map/access';
import { BASE, buildBasemapStyle } from '../map/basemap';
import { boundsOf, frame } from '../map/camera';
import { LineDrawer } from '../map/draw';
import { addNetworkLayers, LAYER, shown, stationFill, stationOpacity } from '../map/layers';
import type { MapToken } from '../map/token';
import { MAX_LEGS, type Route } from './routes';
import { boundsOfPoints, pointOnTrack, trackOf, type Track } from './track';

/**
 * The route game's map: the finished network, a highlighted trip, pins for
 * the two stations, and the train ride itself.
 *
 * A ride is choreographed frame by frame rather than with camera flights, so
 * the zoom stays locked to the train: close on the platform, pulling back as
 * the train picks up speed, closing in again as it brakes into the next
 * interchange or the destination. The clock only runs while the map is on
 * screen and the tab is visible, so a reader who scrolls away mid-trip comes
 * back to the same moment.
 */

export interface PlayHooks {
  /** The train is at the first station of ride `index`, about to leave. */
  board(index: number): void;
  /** The train has arrived at the interchange between ride `index` and the next. */
  change(index: number): void;
  /** Every frame of ride `index` (how far along it the train is) or of the change after it (how far through), 0-1. */
  progress?(stage: 'ride' | 'change', index: number, t: number): void;
  /** The train has arrived at the destination. */
  arrive(): void;
}

interface Options {
  container: HTMLElement;
  viewport: HTMLElement;
  token: MapToken;
  /** Room to keep clear of the panels drawn over the map. */
  padding: () => PaddingOptions;
  /** A station was clicked or tapped. */
  onPick: (station: string) => void;
  /** The map changed size (a phone turned sideways, a window resized), once it has settled. */
  onResize?: () => void;
}

const ROUTE_SOURCE = 'game-route';
const ROUTE_LAYER = {
  casing: (leg: number) => `game-route-casing-${leg}`,
  ahead: (leg: number) => `game-route-ahead-${leg}`,
  done: (leg: number) => `game-route-done-${leg}`,
};

/** The trip is drawn about 1.5 times as wide as the network lines. */
const ROUTE_WIDTH: ExpressionSpecification = ['interpolate', ['exponential', 1.4], ['zoom'], 9, 3.2, 11, 5, 12.5, 6.6, 14, 9, 16, 13];
const CASING_WIDTH: ExpressionSpecification = ['interpolate', ['exponential', 1.4], ['zoom'], 9, 6.4, 11, 8.6, 12.5, 10.6, 14, 13.5, 16, 18];

/** Network lines and stations off the trip step back this far. */
const LINE_DIM = 0.2;
const STATION_DIM = 0.25;

const BOARD_MS = 1100;
const CHANGE_MS = 2600;
const NEXT_RIDE_MS = 650;
const SWITCH_MS = 260;
const ARRIVE_MS = 900;

/** However its first frame is going, the map stops hiding after this long. */
const REVEAL_AFTER_MS = 2500;

const CANCELLED = Symbol('cancelled');
const WIDE = window.matchMedia('(min-width: 1024px)');

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export async function createGameMap(options: Options): Promise<GameMap> {
  applyToken(options.token);

  const map = new MapboxMap({
    container: options.container,
    style: buildBasemapStyle(),
    projection: 'mercator',
    bounds: boundsOf(ALL_FEATURES),
    fitBoundsOptions: { padding: options.padding() },
    attributionControl: false,
    minZoom: 8.5,
    maxZoom: 16.5,
    fadeDuration: 250,
    scrollZoom: false,
    boxZoom: false,
    dragRotate: false,
    dragPan: false,
    keyboard: false,
    doubleClickZoom: false,
    touchZoomRotate: false,
    touchPitch: false,
    pitchWithRotate: false,
    performanceMetricsCollection: false,
  });

  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.getCanvas().tabIndex = -1;

  // Counted while the tab is seen, as on the story map (src/lib/visible-time.ts).
  await new Promise<void>((resolve, reject) => {
    const cancel = afterVisibleTime(20000, () => reject(new Error('Map style timed out')));
    map.once('style.load', () => {
      cancel();
      resolve();
    });
  });
  map.on('error', (event) => console.warn('[game map]', event.error?.message ?? event));

  addNetworkLayers(map);
  return new GameMap(map, options);
}

export class GameMap {
  private readonly finePointer = window.matchMedia('(pointer: fine)').matches;
  private readonly tip: HTMLDivElement;
  private readonly pinFrom: Marker;
  private readonly pinTo: Marker;
  private readonly train: Marker;
  private readonly trainElement: HTMLElement;
  private rippleMarker: Marker | null = null;

  private readonly trackCache = new Map<string, Track[]>();
  private readonly doneVisible: boolean[] = [];
  private readonly dashed: boolean[] = [];
  private pins: { from: string | null; to: string | null } = { from: null, to: null };
  private routeKey: string | null = null;
  /** Key of the trip the network is dimmed around ('' before the first call). */
  private emphasis: string | null = '';
  private emphasisRoute: Route | null = null;
  private trainLine: LineId | null = null;
  private trainRotation = Number.NaN;
  private trainShown = false;

  /** Increments whenever a ride starts or is stopped; stale steps see the change and bail out. */
  private run = 0;
  private skipRun = -1;
  private abort: (() => void) | null = null;
  private frameId = 0;
  private flying = false;
  private playing = false;
  private interactive = false;
  /** On screen and in a visible tab: the ride clock only advances while true. */
  private active = true;
  private revealed = false;
  private revealTimer = 0;

  constructor(
    private readonly map: MapboxMap,
    private readonly options: Options,
  ) {
    // The whole network, finished: every line drawn, underground sections hollow.
    const drawer = new LineDrawer(map);
    ALL_FEATURES.forEach((f) => drawer.set(f, 1));
    network.underground.features.forEach((_, i) => map.setPaintProperty(LAYER.core(i), 'line-opacity', 1));
    map.setPaintProperty(LAYER.stations, 'circle-color', stationFill(true));
    map.setFilter(LAYER.badges, ['in', ['get', 'line'], ['literal', LINE_ORDER]]);
    this.addRouteLayers();
    this.updateLabels(null);

    this.pinFrom = this.makePin('from');
    this.pinTo = this.makePin('to');

    this.trainElement = document.createElement('div');
    this.trainElement.className = 'game-train';
    this.trainElement.innerHTML = '<span class="game-train__halo"></span><span class="game-train__body"></span>';
    this.train = new Marker({ element: this.trainElement, rotationAlignment: 'map', pitchAlignment: 'map' });

    this.tip = document.createElement('div');
    this.tip.className = 'map-tip';
    this.tip.setAttribute('aria-hidden', 'true');
    options.viewport.appendChild(this.tip);

    // Faded in on the first complete frame (`load`), as the story map is. Not on
    // `idle`: that also waits for every camera move and fade to finish, which
    // on a slow phone comes late and never comes while a ride is moving the
    // camera, so a ride started while the map loaded played over an invisible
    // map. A slow first frame is shown anyway after a moment, and a ride always
    // shows the map (see `play`).
    if (map.loaded()) this.reveal();
    else map.once('load', () => this.reveal());
    this.revealTimer = window.setTimeout(() => this.reveal(), REVEAL_AFTER_MS);

    this.bindInteractions();
    this.watchVisibility();
    this.watchResize();
    this.setInteractive(true);
  }

  private reveal(): void {
    if (this.revealed) return;
    this.revealed = true;
    window.clearTimeout(this.revealTimer);
    this.options.container.setAttribute('data-ready', '');
    // Retires the "Loading the map" note underneath, whose pulse would otherwise run for good.
    this.options.viewport.setAttribute('data-map-ready', '');
  }

  /* ------------------------------------------------------------- camera */

  /** The whole network. */
  overview(): void {
    frame(this.map, boundsOf(ALL_FEATURES), this.options.padding(), { maxZoom: 13, pace: 'ui' });
  }

  focusStation(id: string, zoom = 13.4): void {
    const station = stationById.get(id);
    if (!station) return;
    const [lng, lat] = station.geometry.coordinates;
    const d = 0.004;
    frame(
      this.map,
      [
        [lng - d, lat - d],
        [lng + d, lat + d],
      ],
      this.options.padding(),
      { maxZoom: zoom, pace: 'ui' },
    );
  }

  frameStations(ids: string[]): void {
    const points = ids.map((id) => stationById.get(id)?.geometry.coordinates).filter(Boolean) as LngLat[];
    if (points.length) frame(this.map, boundsOfPoints(points), this.options.padding(), { maxZoom: 13.4, pace: 'ui' });
  }

  /** Every option at once, so the choice can be seen before it is made. */
  frameRoutes(routes: Route[]): void {
    const points = routes.flatMap((r) => this.tracksOf(r).flatMap((t) => t.coords));
    if (points.length) frame(this.map, boundsOfPoints(points), this.options.padding(), { maxZoom: 14, pace: 'ui' });
  }

  /** After arriving: the trip drawn in full, framed as a whole. */
  showTrip(route: Route): void {
    this.showRoute(route);
    this.frameRoutes([route]);
  }

  /** Same station twice: close in and mark it. */
  walk(id: string): void {
    this.ripple(id, stationById.get(id)?.properties.primary ?? null);
    this.focusStation(id, 14.6);
  }

  /* -------------------------------------------------------------- route */

  /** Highlight a trip (or clear it). 'full' draws it solid; 'none' leaves it for the train to fill in. */
  showRoute(route: Route | null, progress: 'full' | 'none' = 'full'): void {
    const key = route ? `${route.key}:${progress}` : null;
    if (key !== this.routeKey) {
      this.routeKey = key;
      const tracks = route ? this.tracksOf(route) : [];
      (this.map.getSource(ROUTE_SOURCE) as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: tracks.map((track, leg) => ({
          type: 'Feature',
          properties: { leg, color: LINES[route!.legs[leg].line].color },
          geometry: { type: 'LineString', coordinates: track.coords },
        })),
      });
      for (let leg = 0; leg < MAX_LEGS; leg++) {
        this.setDone(leg, route && progress === 'full' ? 1 : 0);
        // A ride on a line still being planned is dashed, like unfinished track on the story map.
        const line = route?.legs[leg]?.line;
        const planned = Boolean(line && LINES[line].completion === 'planning');
        if (planned !== Boolean(this.dashed[leg])) {
          this.dashed[leg] = planned;
          for (const layer of [ROUTE_LAYER.ahead(leg), ROUTE_LAYER.done(leg)]) {
            this.map.setPaintProperty(layer, 'line-dasharray', planned ? [1.1, 0.8] : undefined);
          }
        }
      }
    }
    this.emphasize(route);
  }

  setPins(from: string | null, to: string | null): void {
    this.pins = { from, to };
    this.placePin(this.pinFrom, from);
    // Walking trips have one place, one pin.
    this.placePin(this.pinTo, to === from ? null : to);
    this.updateLabels(this.emphasisRoute);
  }

  /* --------------------------------------------------------------- ride */

  get isPlaying(): boolean {
    return this.playing;
  }

  async play(route: Route, hooks: PlayHooks): Promise<'done' | 'cancelled'> {
    this.stop();
    const run = this.run;
    this.playing = true;
    this.reveal();
    this.setInteractive(false);
    this.showRoute(route, 'none');
    const tracks = this.tracksOf(route);
    const last = route.legs.length - 1;

    try {
      if (prefersReducedMotion()) {
        this.showRoute(route, 'full');
        this.placeTrain(route.legs[last].line, pointOnTrack(tracks[last], tracks[last].length));
        hooks.arrive();
        return 'done';
      }

      const start = pointOnTrack(tracks[0], 0);
      await this.flight(start.lngLat, this.nearZoom(), run);
      this.placeTrain(route.legs[0].line, start);
      hooks.board(0);
      await this.wait(BOARD_MS, run);

      for (let i = 0; i <= last; i++) {
        await this.ride(route, i, tracks[i], run, (along) => hooks.progress?.('ride', i, along));
        if (i === last) break;
        const next = route.legs[i + 1].line;
        hooks.change(i);
        this.ripple(route.legs[i].to, next);
        await this.switchTrain(next, pointOnTrack(tracks[i + 1], 0), run);
        await this.animate(CHANGE_MS, run, (t) => hooks.progress?.('change', i, t));
        this.ripple(null);
        hooks.board(i + 1);
        await this.wait(NEXT_RIDE_MS, run);
      }

      this.ripple(route.legs[last].to, route.legs[last].line);
      hooks.arrive();
      await this.wait(ARRIVE_MS, run);
      return 'done';
    } catch (error) {
      if (error === CANCELLED) return 'cancelled';
      throw error;
    } finally {
      if (run === this.run) {
        this.playing = false;
        this.setInteractive(true);
      }
    }
  }

  /** Jump to the end of the ride in progress. */
  skip(): void {
    if (!this.playing) return;
    this.skipRun = this.run;
    if (this.flying) this.map.stop();
  }

  /** Cancel the ride in progress and clear the train and markers from it. */
  stop(): void {
    this.run++;
    this.abort?.();
    this.abort = null;
    cancelAnimationFrame(this.frameId);
    if (this.flying) this.map.stop();
    this.playing = false;
    this.hideTrain();
    this.ripple(null);
    this.setInteractive(true);
  }

  private ride(route: Route, index: number, track: Track, run: number, onProgress: (along: number) => void): Promise<void> {
    const line = route.legs[index].line;
    const km = track.length / 1000;
    const duration = clamp(1400 + km * 260, 2400, 6000);
    const padding = this.options.padding();
    const near = this.nearZoom();
    const bounds = boundsOfPoints(track.coords);
    const fit = this.map.cameraForBounds(bounds, { padding, maxZoom: near })?.zoom ?? near - 1.5;
    // Always pull back noticeably, even between neighbouring stations.
    const far = clamp(fit - 0.2, 10.4, near - 1.1);
    const middle: LngLat = [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2];

    return this.animate(duration, run, (t) => {
      const along = easeTrain(t);
      const position = pointOnTrack(track, along * track.length);
      this.placeTrain(line, position);
      this.setDone(index, along);
      onProgress(along);

      // 0 on the platforms, 1 at cruising speed.
      const out = smoothstep(0, 0.3, t) * (1 - smoothstep(0.7, 1, t));
      // Zoomed out, lean towards the middle of the ride so more of it is in view.
      const lean = 0.45 * out;
      const [x, y] = position.lngLat;
      this.map.jumpTo({
        center: [x + (middle[0] - x) * lean, y + (middle[1] - y) * lean],
        zoom: near + (far - near) * out,
        padding,
      });
    });
  }

  private async switchTrain(line: LineId, position: ReturnType<typeof pointOnTrack>, run: number): Promise<void> {
    this.trainElement.setAttribute('data-switching', '');
    await this.wait(SWITCH_MS, run);
    this.placeTrain(line, position);
    this.trainElement.removeAttribute('data-switching');
  }

  private nearZoom(): number {
    return WIDE.matches ? 14.2 : 13.7;
  }

  /* -------------------------------------------------------------- clock */

  /** Calls onFrame with 0-1 while the ride clock runs; rejects if the ride is stopped. */
  private animate(duration: number, run: number, onFrame: (t: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (run !== this.run) {
        reject(CANCELLED);
        return;
      }
      let elapsed = 0;
      let last = performance.now();
      this.abort = () => {
        cancelAnimationFrame(this.frameId);
        reject(CANCELLED);
      };
      const tick = (now: number) => {
        const dt = Math.min(64, now - last);
        last = now;
        const skipping = this.skipRun === run;
        if (this.active || skipping) {
          elapsed = skipping ? duration : elapsed + dt;
          const t = Math.min(1, elapsed / duration);
          onFrame(t);
          if (t >= 1) {
            this.abort = null;
            resolve();
            return;
          }
        }
        this.frameId = requestAnimationFrame(tick);
      };
      this.frameId = requestAnimationFrame(tick);
    });
  }

  private wait(ms: number, run: number): Promise<void> {
    return this.animate(ms, run, () => {});
  }

  /** A mapbox flight to the first platform. */
  private flight(center: LngLat, zoom: number, run: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const padding = this.options.padding();
      if (this.skipRun === run) {
        this.map.jumpTo({ center, zoom, padding });
        resolve();
        return;
      }
      // Settle any camera move already under way first: its moveend must not end this flight.
      this.map.stop();

      let timer = 0;
      const finish = () => {
        window.clearTimeout(timer);
        this.map.off('moveend', finish);
        this.flying = false;
        this.abort = null;
        if (run === this.run) resolve();
        else reject(CANCELLED);
      };
      this.abort = finish;

      const duration = Math.min(2200, 900 + Math.abs(zoom - this.map.getZoom()) * 260);
      this.flying = true;
      this.map.on('moveend', finish);
      timer = window.setTimeout(finish, duration + 800);
      this.map.flyTo({ center, zoom, padding, duration, curve: 1.25, easing: easeInOut, essential: true });
    });
  }

  private watchVisibility(): void {
    let onScreen = true;
    const update = () => {
      this.active = onScreen && document.visibilityState === 'visible';
    };
    new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.intersectionRatio >= 0.2;
        update();
      },
      { threshold: [0, 0.2] },
    ).observe(this.options.viewport);
    document.addEventListener('visibilitychange', update);
  }

  /** mapbox resizes the canvas itself; the framing is ours to redo, once the size has settled. */
  private watchResize(): void {
    const container = this.map.getContainer();
    let last = { w: container.clientWidth, h: container.clientHeight };
    let timer = 0;
    this.map.on('resize', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 2) return;
        last = { w, h };
        this.options.onResize?.();
      }, 200);
    });
  }

  /* ------------------------------------------------------------- layers */

  private addRouteLayers(): void {
    this.map.addSource(ROUTE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      lineMetrics: true,
    });
    // Above the network lines, below the stations. All casings first, so a
    // later ride's casing never cuts into an earlier ride at an interchange.
    const kinds = ['casing', 'ahead', 'done'] as const;
    for (const kind of kinds) {
      for (let leg = 0; leg < MAX_LEGS; leg++) {
        this.map.addLayer(
          {
            id: ROUTE_LAYER[kind](leg),
            type: 'line',
            source: ROUTE_SOURCE,
            filter: ['==', ['get', 'leg'], leg],
            layout: { 'line-cap': 'round', 'line-join': 'round', visibility: kind === 'done' ? 'none' : 'visible' },
            paint:
              kind === 'casing'
                ? { 'line-color': BASE.ink, 'line-width': CASING_WIDTH, 'line-opacity': 0.9 }
                : {
                    'line-color': ['get', 'color'],
                    'line-width': ROUTE_WIDTH,
                    'line-opacity': kind === 'ahead' ? 0.38 : 1,
                    ...(kind === 'done' ? { 'line-trim-offset': [0, 1] as [number, number] } : {}),
                  },
          },
          LAYER.hit,
        );
      }
    }
  }

  /** Reveal the first `p` (0-1) of a ride's solid line. */
  private setDone(leg: number, p: number): void {
    const layer = ROUTE_LAYER.done(leg);
    const on = p > 0.0005;
    if (this.doneVisible[leg] !== on) {
      this.doneVisible[leg] = on;
      this.map.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
    }
    if (on) this.map.setPaintProperty(layer, 'line-trim-offset', [p >= 0.9995 ? 1 : p, 1]);
  }

  private emphasize(route: Route | null): void {
    const key = route?.key ?? null;
    if (key === this.emphasis) return;
    this.emphasis = key;
    this.emphasisRoute = route;

    for (const f of ALL_FEATURES) this.map.setPaintProperty(LAYER.line(f), 'line-opacity', route ? LINE_DIM : 1);
    const badge = route ? 0.35 : 1;
    this.map.setPaintProperty(LAYER.badges, 'icon-opacity', badge);
    this.map.setPaintProperty(LAYER.badges, 'text-opacity', badge);

    const onTrip = route ? [...stationsOf(route)] : [];
    const opacity: ExpressionSpecification = route
      ? ['case', shown, ['case', ['in', ['get', 'id'], ['literal', onTrip]], 1, STATION_DIM], 0]
      : stationOpacity(null, 1);
    this.map.setPaintProperty(LAYER.stations, 'circle-opacity', opacity);
    this.map.setPaintProperty(LAYER.stations, 'circle-stroke-opacity', opacity);
    this.updateLabels(route);
  }

  /**
   * Without a trip: interchanges and termini, the rest once zoomed in. With
   * one: its boarding, change and arrival stations, and the stations passed
   * once zoomed in. The pinned stations are always named.
   */
  private updateLabels(route: Route | null): void {
    const major = new Set<string>();
    const minor = new Set<string>();
    if (route) {
      major.add(route.legs[0].from);
      route.legs.forEach((leg) => major.add(leg.to));
      for (const id of stationsOf(route)) if (!major.has(id)) minor.add(id);
    } else {
      for (const s of network.stations.features) {
        const p = s.properties;
        (p.interchange || p.terminus ? major : minor).add(p.id);
      }
    }
    for (const id of [this.pins.from, this.pins.to]) {
      if (!id) continue;
      major.add(id);
      minor.delete(id);
    }
    this.map.setFilter(LAYER.labels, ['in', ['get', 'id'], ['literal', [...major]]]);
    this.map.setFilter(LAYER.labelsMinor, ['in', ['get', 'id'], ['literal', [...minor]]]);
  }

  private tracksOf(route: Route): Track[] {
    let tracks = this.trackCache.get(route.key);
    if (!tracks) {
      tracks = route.legs.map(trackOf);
      this.trackCache.set(route.key, tracks);
    }
    return tracks;
  }

  /* ------------------------------------------------------------ markers */

  private makePin(kind: 'from' | 'to'): Marker {
    const element = document.createElement('div');
    element.className = `game-pin game-pin--${kind}`;
    // Mapbox positions the marker element with a transform; animations go on the inner span.
    element.innerHTML = `<span class="game-pin__inner"><span class="game-pin__head">${kind === 'from' ? 'A' : 'B'}</span><span class="game-pin__stem"></span></span>`;
    return new Marker({ element, anchor: 'bottom', offset: [0, -6] });
  }

  private placePin(pin: Marker, id: string | null): void {
    const station = id ? stationById.get(id) : undefined;
    if (!station) {
      pin.remove();
      return;
    }
    const element = pin.getElement();
    const moved = element.dataset.station !== id;
    element.dataset.station = id!;
    pin.setLngLat(station.geometry.coordinates);
    // Re-adding restarts the drop-in animation, so a new pick visibly lands.
    if (moved) pin.remove();
    pin.addTo(this.map);
  }

  private placeTrain(line: LineId, position: { lngLat: LngLat; bearing: number }): void {
    if (line !== this.trainLine) {
      this.trainLine = line;
      this.trainElement.style.setProperty('--c', `var(--line-${line.toLowerCase()})`);
    }
    this.train.setLngLat(position.lngLat);
    const rotation = position.bearing - 90;
    if (!(Math.abs(rotation - this.trainRotation) < 0.5)) {
      this.trainRotation = rotation;
      this.train.setRotation(rotation);
    }
    if (!this.trainShown) {
      this.trainShown = true;
      this.train.addTo(this.map);
    }
  }

  private hideTrain(): void {
    if (!this.trainShown) return;
    this.trainShown = false;
    this.train.remove();
    this.trainElement.removeAttribute('data-switching');
  }

  private ripple(station: string | null, line: LineId | null = null): void {
    this.rippleMarker?.remove();
    this.rippleMarker = null;
    const feature = station ? stationById.get(station) : undefined;
    if (!feature) return;
    const element = document.createElement('div');
    element.className = 'game-ripple';
    element.innerHTML = '<span class="game-ripple__ring"></span>';
    if (line) element.style.setProperty('--c', `var(--line-${line.toLowerCase()})`);
    this.rippleMarker = new Marker({ element }).setLngLat(feature.geometry.coordinates).addTo(this.map);
  }

  /* -------------------------------------------------------- interaction */

  private setInteractive(on: boolean): void {
    if (on === this.interactive) return;
    this.interactive = on;
    this.options.viewport.toggleAttribute('data-interactive', on);
    if (on) {
      if (this.finePointer) this.map.dragPan.enable();
      this.map.touchZoomRotate.enable();
      this.map.touchZoomRotate.disableRotation();
      this.map.doubleClickZoom.enable();
      // Only Ctrl/Cmd + wheel and trackpad pinches reach this (see bindInteractions).
      this.map.scrollZoom.enable();
    } else {
      this.map.dragPan.disable();
      this.map.touchZoomRotate.disable();
      this.map.doubleClickZoom.disable();
      this.map.scrollZoom.disable();
      this.hideTip();
      this.map.getCanvas().style.cursor = '';
    }
  }

  private bindInteractions(): void {
    // As on the story map: a plain wheel scrolls the page, Ctrl/Cmd + wheel zooms.
    this.map.getContainer().addEventListener(
      'wheel',
      (event) => {
        if (this.interactive && (event.ctrlKey || event.metaKey)) return;
        event.stopPropagation();
      },
      { capture: true, passive: true },
    );

    this.map.on('mousemove', (event) => {
      if (!this.interactive) return;
      const id = this.pick(event.point, 6);
      this.map.getCanvas().style.cursor = id ? 'pointer' : '';
      if (id && this.finePointer) this.showTip(id, event.point.x, event.point.y);
      else this.hideTip();
    });
    this.map.getCanvasContainer().addEventListener('mouseleave', () => this.hideTip());

    this.map.on('click', (event) => {
      if (!this.interactive) return;
      const id = this.pick(event.point, this.finePointer ? 8 : 16);
      if (id) this.options.onPick(id);
    });
  }

  private pick(point: { x: number; y: number }, tolerance: number): string | null {
    const box: [PointLike, PointLike] = [
      [point.x - tolerance, point.y - tolerance],
      [point.x + tolerance, point.y + tolerance],
    ];
    const hits = this.map.queryRenderedFeatures(box, { layers: [LAYER.stations, LAYER.labels, LAYER.labelsMinor] });
    return (hits[0]?.properties?.id as string | undefined) ?? null;
  }

  private showTip(id: string, x: number, y: number): void {
    const p = stationById.get(id)!.properties;
    const badges = p.lines
      .map((l) => `<span class="badge badge--sm" style="--c: var(--line-${l.toLowerCase()})">${l}</span>`)
      .join('');
    const verb = this.pins.from ? 'set as destination' : 'set as start';
    const html = `<div class="map-tip__name">${esc(p.name)}</div><div class="map-tip__lines">${badges}</div><div class="map-tip__action">Click to ${verb}</div>`;
    if (this.tip.innerHTML !== html) this.tip.innerHTML = html;
    const viewport = this.options.viewport;
    const tx = Math.min(x + 14, viewport.clientWidth - this.tip.offsetWidth - 8);
    const ty = Math.min(y + 14, viewport.clientHeight - this.tip.offsetHeight - 8);
    this.tip.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
    this.tip.setAttribute('data-visible', '');
  }

  private hideTip(): void {
    this.tip.removeAttribute('data-visible');
  }
}

/** Every station on a trip, from the first to the last. */
function stationsOf(route: Route): Set<string> {
  const ids = new Set([route.legs[0].from]);
  for (const leg of route.legs) for (const hop of leg.hops) ids.add(hop.to);
  return ids;
}
