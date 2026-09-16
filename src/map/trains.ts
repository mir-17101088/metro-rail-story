import { Marker, type Map as MapboxMap } from 'mapbox-gl/esm';
import { network, type LngLat } from '../data/network';
import { easeTrain } from '../lib/motion';

/**
 * Two trains shuttle along the section of Line 6 that is actually running
 * (Uttara North to Motijheel), easing into every station and pausing there.
 * They never run onto the unfinished Kamlapur extension.
 */

const DWELL_MS = 700;
const TERMINUS_DWELL_MS = 1600;
const CRUISE_M_PER_S = 760; // story time, not real time
const MIN_RUN_MS = 1100;

const { path, cumulativeM, stops } = network.train;
const stopAlong = stops.map((s) => s.along);

interface TrainState {
  marker: Marker;
  element: HTMLElement;
  stop: number; // index of the station it last left (or is dwelling at)
  dir: 1 | -1;
  phase: 'dwell' | 'run';
  elapsed: number;
  duration: number;
  rotation: number;
}

function pointAt(along: number): { ll: LngLat; bearing: number } {
  const d = Math.max(0, Math.min(cumulativeM[cumulativeM.length - 1], along));
  let lo = 0;
  let hi = cumulativeM.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumulativeM[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = cumulativeM[hi] - cumulativeM[lo] || 1;
  const t = (d - cumulativeM[lo]) / span;
  const a = path[lo];
  const b = path[hi];
  const ll: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const dx = (b[0] - a[0]) * Math.cos((ll[1] * Math.PI) / 180);
  const dy = b[1] - a[1];
  const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
  return { ll, bearing };
}

function runDuration(from: number, to: number): number {
  return Math.max(MIN_RUN_MS, (Math.abs(stopAlong[to] - stopAlong[from]) / CRUISE_M_PER_S) * 1000);
}

export class Trains {
  private readonly trains: TrainState[];
  private frame = 0;
  private last = 0;
  private running = false;

  constructor(map: MapboxMap) {
    const make = (stop: number, dir: 1 | -1): TrainState => {
      const element = document.createElement('div');
      element.className = 'train';
      element.innerHTML = '<div class="train__body"></div>';
      element.style.opacity = '0';
      element.style.transition = 'opacity 450ms ease';
      const { ll, bearing } = pointAt(stopAlong[stop]);
      const marker = new Marker({ element, rotationAlignment: 'map', pitchAlignment: 'map', rotation: bearing - 90 })
        .setLngLat(ll)
        .addTo(map);
      return { marker, element, stop, dir, phase: 'dwell', elapsed: 0, duration: TERMINUS_DWELL_MS, rotation: bearing - 90 };
    };
    this.trains = [make(0, 1), make(stops.length - 1, -1)];

    // Trains shrink when the camera pulls back so they never outweigh the lines.
    const rescale = () => {
      const k = Math.min(1, Math.max(0.5, 0.5 + (map.getZoom() - 9.5) * 0.2));
      for (const t of this.trains) t.element.style.setProperty('--train-scale', k.toFixed(2));
    };
    map.on('zoom', rescale);
    rescale();
    // Stagger the second train so the two never move in lock-step.
    this.trains[1].elapsed = -2600;
  }

  /** Show, hide or dim. Opacity is a CSS transition on the marker element. */
  setAppearance(opacity: number): void {
    const value = String(opacity);
    for (const t of this.trains) t.element.style.opacity = value;
  }

  /** Reduced motion: park the trains at two stations, no movement. */
  park(): void {
    this.stop();
    const parked = [Math.min(8, stops.length - 1), Math.min(12, stops.length - 1)];
    this.trains.forEach((t, i) => {
      const { ll, bearing } = pointAt(stopAlong[parked[i]]);
      t.marker.setLngLat(ll).setRotation(bearing - 90);
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(64, now - this.last);
      this.last = now;
      for (const t of this.trains) this.advance(t, dt);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private advance(t: TrainState, dt: number): void {
    t.elapsed += dt;
    if (t.elapsed < 0) return;

    if (t.phase === 'dwell') {
      if (t.elapsed < t.duration) return;
      const next = t.stop + t.dir;
      if (next < 0 || next >= stops.length) {
        t.dir = (t.dir * -1) as 1 | -1;
      }
      t.phase = 'run';
      t.elapsed = 0;
      t.duration = runDuration(t.stop, t.stop + t.dir);
      return;
    }

    const to = t.stop + t.dir;
    const k = Math.min(1, t.elapsed / t.duration);
    const along = stopAlong[t.stop] + (stopAlong[to] - stopAlong[t.stop]) * easeTrain(k);
    const { ll, bearing } = pointAt(along);
    t.marker.setLngLat(ll);
    const rotation = bearing - 90;
    if (Math.abs(rotation - t.rotation) > 0.5) {
      t.rotation = rotation;
      t.marker.setRotation(rotation);
    }

    if (k >= 1) {
      t.stop = to;
      t.phase = 'dwell';
      t.elapsed = 0;
      const atEnd = to === 0 || to === stops.length - 1;
      t.duration = atEnd ? TERMINUS_DWELL_MS : DWELL_MS;
    }
  }
}
