import {
  Map as MapboxMap,
  AttributionControl,
  NavigationControl,
  Marker,
  type ExpressionSpecification,
  type PointLike,
} from 'mapbox-gl/esm';
import 'mapbox-gl/dist/mapbox-gl.css';

import { CONFIG } from '../config';
import { LINES, LINE_ORDER, type LineId } from '../data/lines';
import {
  ALL_FEATURES,
  featureById,
  featuresOfLine,
  lineOfFeature,
  network,
  stationById,
  stationsOfLine,
  type FeatureId,
} from '../data/network';
import type { NetworkPanel, Selection } from '../explorer/panel';
import { clamp, easeOut, invertEase, easeInOut, onReducedMotionChange, prefersReducedMotion } from '../lib/motion';
import { STEPS, DRAW_SEQUENCE, type StepState } from '../story/steps';
import { applyToken } from './access';
import { buildBasemapStyle } from './basemap';
import { boundsOf, frame, paddingFor } from './camera';
import { LineDrawer } from './draw';
import { addNetworkLayers, LAYER, stationFill, stationOpacity } from './layers';
import type { MapToken } from './token';
import { Trains } from './trains';

const STORY_DIM = 0.3;
const SELECT_DIM = 0.14;
/** Elevated parts of spotlighted lines while their underground tubes are emphasised. */
const ELEVATED_UNDER_SPOTLIGHT = 0.45;

interface Options {
  container: HTMLElement;
  stage: HTMLElement;
  panel: NetworkPanel;
  token: MapToken;
}

export async function createStoryMap(options: Options): Promise<StoryMap> {
  const { container, stage, token } = options;
  applyToken(token);

  // Zoom buttons: bottom right on desktop, top right on phones (the explorer sheet has the bottom).
  const wide = window.matchMedia('(min-width: 1024px)').matches;
  const corner = wide ? 'bottom-right' : 'top-right';

  const map = new MapboxMap({
    container,
    style: buildBasemapStyle(),
    projection: 'mercator',
    bounds: boundsOf(['6-operational', '6-extension']),
    fitBoundsOptions: { padding: paddingFor(stage, 'hero') },
    attributionControl: false,
    // The two credits in opposite bottom corners, as on the route game's map,
    // rather than stacked in one: the wordmark left, the attribution button right.
    logoPosition: 'bottom-left',
    minZoom: 8,
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
  map.addControl(new NavigationControl({ showCompass: false }), corner);
  map.getCanvas().tabIndex = -1;

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Map style timed out')), 20000);
    map.once('style.load', () => {
      window.clearTimeout(timer);
      resolve();
    });
  });

  map.on('error', (event) => console.warn('[map]', event.error?.message ?? event));

  addNetworkLayers(map);
  return new StoryMap(map, options);
}

export class StoryMap {
  private readonly drawer: LineDrawer;
  private readonly trains: Trains | null;
  private readonly tip: HTMLDivElement;
  private readonly reset: HTMLButtonElement | null;
  private readonly finePointer = window.matchMedia('(pointer: fine)').matches;

  private stepId: string | null = null;
  private state: StepState | null = null;
  private focus: LineId[] | null = null;
  private dim = 1;
  private focusSpotlight = false;
  private depth: boolean | null = null;
  private spotlight = false;
  private extension: 'dashed' | 'solid' | null = null;
  private cameraKey = '';
  private interactive = false;
  private selection: Selection = null;
  private badgeLines = '';
  private stationTween = 0;
  private annotation: { marker: Marker; element: HTMLElement; timer: number } | null = null;
  private stageVisible = true;
  private lastSize = { w: 0, h: 0 };

  /**
   * Resolves once the map has something worth looking at: the style is up and
   * the first tiles of the opening view have been drawn. This is what fades the
   * stage in and what the loading screen waits on.
   */
  readonly painted: Promise<void>;

  /** Resolves once the first scene has fully rendered: tiles, glyphs and lines. */
  readonly ready: Promise<void>;

  constructor(
    private readonly map: MapboxMap,
    private readonly options: Options,
  ) {
    this.drawer = new LineDrawer(map, () => this.syncBadges());
    this.trains = CONFIG.trains ? new Trains(map) : null;

    this.tip = document.createElement('div');
    this.tip.className = 'map-tip';
    this.tip.setAttribute('aria-hidden', 'true');
    options.stage.appendChild(this.tip);

    this.reset = this.addResetButton();

    this.painted = new Promise((resolve) => {
      const show = () => {
        options.container.setAttribute('data-ready', '');
        resolve();
      };
      // `load` has already gone by if the opening view needed no tiles at all.
      if (map.loaded()) show();
      else map.once('load', show);
    });

    this.ready = new Promise((resolve) => map.once('idle', () => resolve()));

    this.bindInteractions();
    this.watchVisibility();
    this.watchResize();
  }

  /**
   * Re-frame the current view after something on top of the map changed size
   * (the explorer collapsing, or its bottom sheet being resized).
   */
  refit(): void {
    if (!this.stepId || !this.state) return;
    if (this.interactive && this.selection) {
      this.frameSelection(this.selection);
      return;
    }
    const padding = paddingFor(this.options.stage, this.stepId);
    frame(this.map, boundsOf(this.state.camera.features, this.state.camera.stations), padding, {
      maxZoom: this.state.camera.maxZoom ?? 13,
      pace: 'ui',
    });
  }

  /* --------------------------------------------------------------- steps */

  go(stepId: string, { instant = false } = {}): void {
    const next = STEPS[stepId];
    if (!next) return;
    const firstRun = this.stepId === null;
    this.stepId = stepId;
    this.state = next;

    const immediate = instant || firstRun;
    const reduced = prefersReducedMotion();

    if (!next.interactive) this.setInteractive(false);

    const cameraMoves = this.updateCamera(stepId, next, immediate);
    this.updateLines(next, immediate, reduced, cameraMoves);
    this.updateExtension(next.extension ?? 'solid');
    this.updateDepth(Boolean(next.depth));
    this.updateSpotlight(Boolean(next.emphasizeUnderground));
    this.applyFocus(next.focus ?? null, next.dim ?? STORY_DIM, immediate);
    this.updateLabels();
    this.updateAnnotation(next.annotation === 'kamlapur', immediate || reduced ? 0 : cameraMoves ? 1400 : 500);
    this.updateTrains();

    if (next.interactive) this.setInteractive(true);
  }

  /* --------------------------------------------------------------- lines */

  private drawDuration(feature: FeatureId): number {
    const km = featureById.get(feature)!.properties.lengthM / 1000;
    return clamp(900 + km * 55, 1000, 2600);
  }

  private updateLines(next: StepState, immediate: boolean, reduced: boolean, cameraMoves: boolean): void {
    const wanted = new Set(next.features);

    for (const f of ALL_FEATURES) {
      if (wanted.has(f) || this.drawer.targetOf(f) <= 0) continue;
      if (immediate || reduced) this.drawer.set(f, 0);
      else this.drawer.animate(f, 0, 480);
    }

    const toDraw = next.features.filter((f) => this.drawer.targetOf(f) < 1);
    if (!toDraw.length) return;

    if (immediate) {
      toDraw.forEach((f) => this.drawer.set(f, 1));
      return;
    }

    if (reduced) {
      // Reduced motion: no drawing movement, a short fade instead.
      toDraw.forEach((f) => {
        const layer = LAYER.line(f);
        this.map.setPaintProperty(layer, 'line-opacity-transition', { duration: 0, delay: 0 });
        this.map.setPaintProperty(layer, 'line-opacity', 0);
        this.drawer.set(f, 1);
      });
      requestAnimationFrame(() => {
        toDraw.forEach((f) =>
          this.map.setPaintProperty(LAYER.line(f), 'line-opacity-transition', { duration: 450, delay: 0 }),
        );
        this.applyFocus(this.focus, this.dim, false, true);
      });
      return;
    }

    const base = cameraMoves ? 650 : 120;
    for (const f of toDraw) {
      const seq = DRAW_SEQUENCE[f];
      let delay = seq?.delay ?? 0;
      if (seq?.after && toDraw.includes(seq.after) && seq.at !== undefined) {
        delay = this.drawDuration(seq.after) * invertEase(easeInOut, seq.at);
      }
      this.drawer.animate(f, 1, this.drawDuration(f), base + delay);
    }
  }

  private updateExtension(style: 'dashed' | 'solid'): void {
    if (style === this.extension) return;
    this.extension = style;
    this.map.setPaintProperty(LAYER.line('6-extension'), 'line-dasharray', style === 'dashed' ? [0.9, 1.6] : undefined);
  }

  private updateDepth(on: boolean): void {
    if (on === this.depth) return;
    this.depth = on;
    network.underground.features.forEach((_, i) => {
      this.map.setPaintProperty(LAYER.core(i), 'line-opacity', on ? 1 : 0);
    });
    this.map.setPaintProperty(LAYER.stations, 'circle-color', stationFill(on));
  }

  /** Fade the bold underground tubes in or out. Line opacity follows in applyFocus. */
  private updateSpotlight(on: boolean): void {
    if (on === this.spotlight) return;
    this.spotlight = on;
    network.underground.features.forEach((_, i) => {
      this.map.setPaintProperty(LAYER.tube(i), 'line-opacity', on ? 1 : 0);
      this.map.setPaintProperty(LAYER.tubeCore(i), 'line-opacity', on ? 1 : 0);
    });
  }

  /* --------------------------------------------------------------- focus */

  private applyFocus(focus: LineId[] | null, dim: number, immediate: boolean, force = false): void {
    const spotlight = this.spotlight;
    const same =
      !force &&
      dim === this.dim &&
      spotlight === this.focusSpotlight &&
      JSON.stringify(focus) === JSON.stringify(this.focus);
    if (same) return;
    const previous = { focus: this.focus, dim: this.dim, spotlight: this.focusSpotlight };
    this.focus = focus;
    this.dim = dim;
    this.focusSpotlight = spotlight;

    const inFocus = (line: LineId) => !focus || focus.includes(line);
    const focusedOpacity = spotlight ? ELEVATED_UNDER_SPOTLIGHT : 1;

    for (const f of ALL_FEATURES) {
      this.map.setPaintProperty(LAYER.line(f), 'line-opacity', inFocus(lineOfFeature(f)) ? focusedOpacity : dim);
    }

    const badgeOpacity: ExpressionSpecification = focus
      ? ['case', ['in', ['get', 'line'], ['literal', focus]], 1, dim]
      : ['literal', 1];
    this.map.setPaintProperty(LAYER.badges, 'icon-opacity', badgeOpacity);
    this.map.setPaintProperty(LAYER.badges, 'text-opacity', badgeOpacity);

    this.tweenStations(previous, { focus, dim, spotlight }, immediate || prefersReducedMotion() ? 0 : 450);
    this.updateTrains();
  }

  /** Station dimming cross-fades between the old and new focus sets. */
  private tweenStations(
    from: { focus: LineId[] | null; dim: number; spotlight: boolean },
    to: { focus: LineId[] | null; dim: number; spotlight: boolean },
    duration: number,
  ): void {
    cancelAnimationFrame(this.stationTween);
    const layers = [LAYER.stations];
    const setAt = (t: number) => {
      const expr: ExpressionSpecification =
        t >= 1
          ? stationOpacity(to.focus, to.dim, to.spotlight)
          : [
              '+',
              ['*', stationOpacity(from.focus, from.dim, from.spotlight), 1 - t],
              ['*', stationOpacity(to.focus, to.dim, to.spotlight), t],
            ];
      for (const layer of layers) {
        this.map.setPaintProperty(layer, 'circle-opacity', expr);
        this.map.setPaintProperty(layer, 'circle-stroke-opacity', expr);
      }
    };
    if (duration <= 0) {
      setAt(1);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const k = clamp((now - start) / duration);
      setAt(easeOut(k));
      if (k < 1) this.stationTween = requestAnimationFrame(tick);
    };
    this.stationTween = requestAnimationFrame(tick);
  }

  /* -------------------------------------------------------------- labels */

  private updateLabels(): void {
    const s = this.state;
    if (!s) return;
    const major = new Set<string>();
    const minor = new Set<string>();

    if (s.labelKeyStations) {
      for (const st of network.stations.features) {
        const p = st.properties;
        if (p.interchange || p.terminus) major.add(p.id);
        else minor.add(p.id);
      }
    } else {
      (s.labels ?? []).forEach((id) => major.add(id));
    }

    const sel = this.interactive ? this.selection : null;
    if (sel?.kind === 'line') stationsOfLine(sel.line).forEach((st) => major.add(st.properties.id));
    if (sel?.kind === 'station') {
      major.add(sel.id);
      if (sel.from) stationsOfLine(sel.from).forEach((st) => major.add(st.properties.id));
    }
    major.forEach((id) => minor.delete(id));

    this.map.setFilter(LAYER.labels, ['in', ['get', 'id'], ['literal', [...major]]]);
    this.map.setFilter(LAYER.labelsMinor, ['in', ['get', 'id'], ['literal', [...minor]]]);
    this.map.setFilter(LAYER.selected, ['==', ['get', 'id'], sel?.kind === 'station' ? sel.id : '']);
  }

  /** Line badges appear once a line has finished drawing. */
  private syncBadges(): void {
    const complete = LINE_ORDER.filter((line) => {
      const feats = featuresOfLine(line).filter((f) => this.state?.features.includes(f));
      return feats.length > 0 && feats.every((f) => this.drawer.progressOf(f) > 0.97);
    });
    const key = complete.join(',');
    if (key === this.badgeLines) return;
    this.badgeLines = key;
    this.map.setFilter(LAYER.badges, ['in', ['get', 'line'], ['literal', complete]]);
    this.updateTrains();
  }

  /* ---------------------------------------------------------- annotation */

  private updateAnnotation(on: boolean, delay: number): void {
    if (on && !this.annotation) {
      const element = document.createElement('div');
      element.className = 'annot annot-enter';
      element.innerHTML =
        '<span class="annot__ring"></span><span class="annot__label"><strong>Kamlapur</strong><span>77.2% built</span></span>';
      const kamlapur = stationById.get('kamlapur')!;
      const marker = new Marker({ element, anchor: 'left', offset: [-14, 0] })
        .setLngLat(kamlapur.geometry.coordinates)
        .addTo(this.map);
      const timer = window.setTimeout(() => element.setAttribute('data-visible', ''), delay);
      this.annotation = { marker, element, timer };
    } else if (!on && this.annotation) {
      const { marker, element, timer } = this.annotation;
      window.clearTimeout(timer);
      element.removeAttribute('data-visible');
      window.setTimeout(() => marker.remove(), 420);
      this.annotation = null;
    }
  }

  /* -------------------------------------------------------------- camera */

  private updateCamera(stepId: string, next: StepState, immediate: boolean): boolean {
    const layout = stepId === 'hero' ? 'hero' : stepId === 'network' ? 'network' : 'column';
    const key = CONFIG.cameraMotion ? `${next.camera.key}:${layout}` : `static:${layout}`;
    if (key === this.cameraKey && !immediate) return false;
    const moved = this.cameraKey !== '' && key !== this.cameraKey;
    this.cameraKey = key;

    if (CONFIG.cameraMotion) {
      const base = paddingFor(this.options.stage, stepId);
      const padding = { ...base, right: (base.right ?? 0) + (next.camera.roomRight ?? 0) };
      frame(this.map, boundsOf(next.camera.features, next.camera.stations), padding, {
        maxZoom: next.camera.maxZoom ?? 13,
        instant: immediate,
      });
    } else {
      frame(this.map, boundsOf(ALL_FEATURES), paddingFor(this.options.stage, stepId), { instant: true });
    }
    return moved && CONFIG.cameraMotion;
  }

  private watchResize(): void {
    let timer = 0;
    this.map.on('resize', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const w = this.options.stage.clientWidth;
        const h = this.options.stage.clientHeight;
        if (Math.abs(w - this.lastSize.w) < 2 && Math.abs(h - this.lastSize.h) < 120) return;
        this.lastSize = { w, h };
        if (this.stepId && this.state) {
          this.cameraKey = '';
          this.updateCamera(this.stepId, this.state, true);
        }
      }, 200);
    });
    this.lastSize = { w: this.options.stage.clientWidth, h: this.options.stage.clientHeight };
  }

  /* -------------------------------------------------------------- trains */

  private watchVisibility(): void {
    new IntersectionObserver(([entry]) => {
      this.stageVisible = entry.isIntersecting;
      this.updateTrains();
    }).observe(this.options.stage);
    document.addEventListener('visibilitychange', () => this.updateTrains());
    onReducedMotionChange(() => this.updateTrains());
  }

  private updateTrains(): void {
    if (!this.trains) return;
    const drawn = this.drawer.progressOf('6-operational') > 0.97;
    const dimmed = Boolean(this.focus && !this.focus.includes('6'));
    this.trains.setAppearance(drawn ? (dimmed ? Math.max(0.25, this.dim) : 1) : 0);

    const shouldRun = drawn && this.stageVisible && document.visibilityState === 'visible';
    if (prefersReducedMotion()) {
      this.trains.park();
    } else if (shouldRun) {
      this.trains.start();
    } else {
      this.trains.stop();
    }
  }

  /* --------------------------------------------------------- interaction */

  private setInteractive(on: boolean): void {
    if (on === this.interactive) return;
    this.interactive = on;
    const { stage, panel } = this.options;
    stage.toggleAttribute('data-interactive', on);

    if (on) {
      if (this.finePointer) this.map.dragPan.enable();
      this.map.touchZoomRotate.enable();
      this.map.touchZoomRotate.disableRotation();
      this.map.doubleClickZoom.enable();
      // Only Ctrl/Cmd + wheel and trackpad pinches reach this (see bindInteractions).
      this.map.scrollZoom.enable();
      this.map.setFilter(LAYER.hit, ['in', ['get', 'id'], ['literal', ALL_FEATURES]]);
    } else {
      this.map.dragPan.disable();
      this.map.touchZoomRotate.disable();
      this.map.doubleClickZoom.disable();
      this.map.scrollZoom.disable();
      this.map.setFilter(LAYER.hit, ['in', ['get', 'id'], ['literal', []]]);
      this.hideTip();
      this.map.getCanvas().style.cursor = '';
      if (panel.current) panel.select(null, { silent: true });
      this.selection = null;
      this.syncReset();
    }
  }

  /**
   * "Show all lines", added under the zoom buttons in their own control group.
   *
   * The explorer's way back sits at the top of the detail, over in the panel,
   * but a reader who has just tapped a station on the map is looking at the
   * map. This puts the way out where their eye already is. It exists only
   * while something is selected.
   *
   * Sharing the zoom control's group rather than adding a control of its own
   * keeps it under the zoom buttons in both layouts (the group is bottom-right
   * on desktop, top-right on phones, and mapbox stacks whole controls in
   * opposite orders in the two corners) and inherits the group's divider.
   */
  private addResetButton(): HTMLButtonElement | null {
    const group = this.map.getContainer().querySelector('.mapboxgl-ctrl-group');
    if (!group) return null;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-reset';
    button.hidden = true;
    button.title = 'Show all lines';
    button.setAttribute('aria-label', 'Show all lines');
    button.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" /></svg>';
    button.addEventListener('click', () => this.options.panel.select(null));
    group.appendChild(button);
    return button;
  }

  /** The button is only there when there is something to clear. */
  private syncReset(): void {
    if (this.reset) this.reset.hidden = !this.selection;
  }

  private bindInteractions(): void {
    const { panel } = this.options;

    // A plain wheel over the map always scrolls the story. Ctrl/Cmd + wheel, and
    // trackpad pinches (which arrive as ctrl + wheel), zoom the map instead of
    // the whole browser page. Stopping the event in the capture phase keeps it
    // away from mapbox's handler without cancelling the page scroll.
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
      const hit = this.pick(event.point, 6);
      this.map.getCanvas().style.cursor = hit ? 'pointer' : '';
      if (!hit || !this.finePointer) {
        this.hideTip();
        return;
      }
      this.showTip(hit, event.point.x, event.point.y);
    });
    this.map.getCanvasContainer().addEventListener('mouseleave', () => this.hideTip());

    this.map.on('click', (event) => {
      if (!this.interactive) return;
      const hit = this.pick(event.point, this.finePointer ? 6 : 14);
      if (!hit) {
        if (panel.current) panel.select(null);
        return;
      }
      if (hit.kind === 'station') {
        const from = panel.current?.kind === 'line' ? panel.current.line : undefined;
        panel.select({ kind: 'station', id: hit.id, from });
      } else {
        panel.select({ kind: 'line', line: hit.line });
      }
    });

    panel.onChange((selection) => this.applySelection(selection));
  }

  private pick(
    point: { x: number; y: number },
    tolerance: number,
  ): { kind: 'station'; id: string } | { kind: 'line'; line: LineId } | null {
    const box = (r: number): [PointLike, PointLike] => [
      [point.x - r, point.y - r],
      [point.x + r, point.y + r],
    ];
    // Line badges sit ~500 m beyond each terminus. Zoomed out that overlaps the
    // line itself, but zoomed in the badge is tens of pixels past the track, so
    // it has to be hit-tested on its own or a click on it reads as empty map.
    const badges = this.map.queryRenderedFeatures(box(Math.max(2, tolerance - 4)), { layers: [LAYER.badges] });
    if (badges.length) {
      const line = badges[0].properties?.line as LineId | undefined;
      if (line) return { kind: 'line', line };
    }
    const stations = this.map.queryRenderedFeatures(box(tolerance), {
      layers: [LAYER.stations, LAYER.labels, LAYER.labelsMinor],
    });
    if (stations.length) {
      const id = stations[0].properties?.id as string | undefined;
      if (id) return { kind: 'station', id };
    }
    const lines = this.map.queryRenderedFeatures(box(tolerance), { layers: [LAYER.hit] });
    if (lines.length) {
      const line = lines[0].properties?.line as LineId | undefined;
      if (line) return { kind: 'line', line };
    }
    return null;
  }

  private showTip(hit: { kind: 'station'; id: string } | { kind: 'line'; line: LineId }, x: number, y: number): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const badge = (l: LineId) =>
      `<span class="badge badge--sm" style="--c: var(--line-${l.toLowerCase()})">${l}</span>`;
    let html = '';
    if (hit.kind === 'station') {
      const p = stationById.get(hit.id)!.properties;
      html = `<div class="map-tip__name">${esc(p.name)}</div><div class="map-tip__lines">${p.lines.map(badge).join('')}</div>`;
    } else {
      const meta = LINES[hit.line];
      html = `<div class="map-tip__name">${esc(meta.name)}</div><div>${esc(meta.route)}</div>`;
    }
    if (this.tip.innerHTML !== html) this.tip.innerHTML = html;
    const stage = this.options.stage;
    const tx = Math.min(x + 14, stage.clientWidth - this.tip.offsetWidth - 8);
    const ty = Math.min(y + 14, stage.clientHeight - this.tip.offsetHeight - 8);
    this.tip.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
    this.tip.setAttribute('data-visible', '');
  }

  private hideTip(): void {
    this.tip.removeAttribute('data-visible');
  }

  private applySelection(selection: Selection): void {
    if (!this.interactive || !this.state) return;
    this.selection = selection;
    this.syncReset();

    if (!selection) {
      this.applyFocus(null, STORY_DIM, false);
      this.updateLabels();
      frame(this.map, boundsOf(this.state.camera.features), paddingFor(this.options.stage, 'network'), { pace: 'ui' });
      return;
    }

    if (selection.kind === 'line') {
      this.applyFocus([selection.line], SELECT_DIM, false);
    } else {
      const station = stationById.get(selection.id);
      if (!station) return;
      // Keep every line serving the station in focus, not just the line it was picked from.
      this.applyFocus(station.properties.lines, SELECT_DIM, false);
    }
    this.updateLabels();
    this.frameSelection(selection);
  }

  private frameSelection(selection: NonNullable<Selection>): void {
    const padding = paddingFor(this.options.stage, 'network');
    if (selection.kind === 'line') {
      frame(this.map, boundsOf(featuresOfLine(selection.line)), padding, { maxZoom: 13.4, pace: 'ui' });
      return;
    }
    const station = stationById.get(selection.id);
    if (!station) return;
    const zoom = Math.max(this.map.getZoom(), 13.2);
    const [lng, lat] = station.geometry.coordinates;
    const d = 0.004;
    frame(
      this.map,
      [
        [lng - d, lat - d],
        [lng + d, lat + d],
      ],
      padding,
      { maxZoom: zoom, pace: 'ui' },
    );
  }
}
