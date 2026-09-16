import type { Map as MapboxMap } from 'mapbox-gl/esm';
import { network, ALL_FEATURES, lineOfFeature, type FeatureId } from '../data/network';
import { clamp, easeInOut, easeOut } from '../lib/motion';
import { LAYER, SRC } from './layers';

interface Tween {
  from: number;
  to: number;
  start: number;
  duration: number;
  ease: (t: number) => number;
}

const EPS = 0.0005;

/**
 * Draws and retracts line features by animating `line-trim-offset`, a paint
 * property, so no geometry is re-sent to the worker per frame. Every tween
 * starts from the currently rendered value, which makes fast scrolling
 * (interrupting a draw halfway) seamless in both directions.
 *
 * Stations appear the moment a line reaches them.
 */
export class LineDrawer {
  private readonly rendered = new Map<FeatureId, number>();
  private readonly visible = new Map<string, boolean>();
  private readonly tweens = new Map<FeatureId, Tween>();
  private readonly stationState = new Map<number, string>();
  private frame = 0;

  private readonly cores = network.underground.features.map((u, index) => ({
    layers: [LAYER.tube(index), LAYER.tubeCore(index), LAYER.core(index)],
    feature: u.properties.feature,
    from: u.properties.from,
    to: u.properties.to,
  }));

  constructor(
    private readonly map: MapboxMap,
    private readonly onChange: () => void = () => {},
  ) {
    for (const f of ALL_FEATURES) this.rendered.set(f, 0);
  }

  progressOf(feature: FeatureId): number {
    return this.rendered.get(feature) ?? 0;
  }

  /** Target value the feature is heading to (or sitting at). */
  targetOf(feature: FeatureId): number {
    return this.tweens.get(feature)?.to ?? this.progressOf(feature);
  }

  set(feature: FeatureId, value: number): void {
    this.tweens.delete(feature);
    this.apply(feature, value);
    this.syncStations();
    this.onChange();
  }

  /** Draw (to = 1) or retract (to = 0). Duration in ms; delay in ms. */
  animate(feature: FeatureId, to: number, duration: number, delay = 0): void {
    const from = this.progressOf(feature);
    if (Math.abs(from - to) < EPS && !this.tweens.has(feature)) return;
    const retracting = to < from;
    this.tweens.set(feature, {
      from,
      to,
      start: performance.now() + delay,
      duration: Math.max(1, duration),
      ease: retracting ? easeOut : easeInOut,
    });
    this.ensureLoop();
  }

  cancelAll(): void {
    this.tweens.clear();
  }

  private ensureLoop(): void {
    if (this.frame) return;
    const tick = (now: number) => {
      for (const [feature, t] of this.tweens) {
        if (now < t.start) continue;
        const k = clamp((now - t.start) / t.duration);
        this.apply(feature, t.from + (t.to - t.from) * t.ease(k));
        if (k >= 1) this.tweens.delete(feature);
      }
      this.syncStations();
      this.onChange();
      this.frame = this.tweens.size ? requestAnimationFrame(tick) : 0;
    };
    this.frame = requestAnimationFrame(tick);
  }

  private setVisibility(layer: string, on: boolean): void {
    if (this.visible.get(layer) === on) return;
    this.visible.set(layer, on);
    this.map.setLayoutProperty(layer, 'visibility', on ? 'visible' : 'none');
  }

  private apply(feature: FeatureId, raw: number): void {
    const p = clamp(raw);
    this.rendered.set(feature, p);
    const layer = LAYER.line(feature);
    const on = p > EPS;
    this.setVisibility(layer, on);
    if (on) this.map.setPaintProperty(layer, 'line-trim-offset', [p >= 1 - EPS ? 1 : p, 1]);

    for (const core of this.cores) {
      if (core.feature !== feature) continue;
      const cp = clamp((p - core.from) / Math.max(EPS, core.to - core.from));
      const coreOn = cp > EPS;
      for (const layer of core.layers) {
        this.setVisibility(layer, coreOn);
        if (coreOn) this.map.setPaintProperty(layer, 'line-trim-offset', [cp >= 1 - EPS ? 1 : cp, 1]);
      }
    }
  }

  /**
   * A station appears when any of its lines reaches it, and only takes the
   * interchange style once a second line has actually been drawn through it.
   */
  private syncStations(): void {
    for (const s of network.stations.features) {
      const lines = new Set<string>();
      for (const o of s.properties.on) {
        const p = this.rendered.get(o.feature) ?? 0;
        if (p > EPS && p >= o.progress - 0.004) lines.add(lineOfFeature(o.feature));
      }
      const shown = lines.size > 0;
      const ix = lines.size > 1;
      const key = `${shown}${ix}`;
      if (this.stationState.get(s.id) === key) continue;
      this.stationState.set(s.id, key);
      this.map.setFeatureState({ source: SRC.stations, id: s.id }, { shown, ix });
    }
  }
}
