import { featureById, type FeatureId, type LngLat } from '../data/network';
import type { Leg } from './routes';

/**
 * The drawn path of a ride: the line geometry between its first and last
 * station, in travel order, with distances for placing the train along it.
 * Distances use the same local flat projection as scripts/build-network.mjs,
 * so they line up with the station positions (0-1) stored in network.json.
 */

export interface Track {
  coords: LngLat[];
  /** Metres from the start to each vertex. */
  cum: number[];
  length: number;
}

const LAT0 = 23.75;
const KX = (Math.PI / 180) * 6371008.8 * Math.cos((LAT0 * Math.PI) / 180);
const KY = (Math.PI / 180) * 6371008.8;

const dist = (a: LngLat, b: LngLat) => Math.hypot((b[0] - a[0]) * KX, (b[1] - a[1]) * KY);

function cumulative(coords: LngLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  return cum;
}

const featureCum = new Map<FeatureId, number[]>();

function cumOf(feature: FeatureId): number[] {
  let cum = featureCum.get(feature);
  if (!cum) {
    cum = cumulative(featureById.get(feature)!.geometry.coordinates);
    featureCum.set(feature, cum);
  }
  return cum;
}

/** Index of the segment containing distance d (cum[i] <= d <= cum[i + 1]). */
function segmentAt(cum: number[], d: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

function interpolate(coords: LngLat[], cum: number[], d: number): LngLat {
  const i = segmentAt(cum, d);
  const span = cum[i + 1] - cum[i] || 1;
  const t = Math.max(0, Math.min(1, (d - cum[i]) / span));
  const a = coords[i];
  const b = coords[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Geometry of a feature between two positions (0-1), in the order given. */
function slice(feature: FeatureId, fromP: number, toP: number): LngLat[] {
  const coords = featureById.get(feature)!.geometry.coordinates;
  const cum = cumOf(feature);
  const total = cum[cum.length - 1];
  const a = Math.min(fromP, toP) * total;
  const b = Math.max(fromP, toP) * total;
  const out: LngLat[] = [interpolate(coords, cum, a)];
  for (let i = 0; i < coords.length; i++) if (cum[i] > a && cum[i] < b) out.push(coords[i]);
  out.push(interpolate(coords, cum, b));
  return fromP <= toP ? out : out.reverse();
}

export function trackOf(leg: Leg): Track {
  const coords: LngLat[] = [];
  for (const hop of leg.hops) {
    const part = slice(hop.feature, hop.fromP, hop.toP);
    // Consecutive hops meet at a station; skip the repeated point.
    const last = coords[coords.length - 1];
    coords.push(...(last && dist(last, part[0]) < 0.5 ? part.slice(1) : part));
  }
  const cum = cumulative(coords);
  return { coords, cum, length: cum[cum.length - 1] };
}

/** Position and heading (degrees clockwise from north) at a distance along a track. */
export function pointOnTrack(track: Track, meters: number): { lngLat: LngLat; bearing: number } {
  const d = Math.max(0, Math.min(track.length, meters));
  const i = Math.min(segmentAt(track.cum, d), track.coords.length - 2);
  const a = track.coords[Math.max(0, i)];
  const b = track.coords[Math.max(0, i) + 1] ?? a;
  const bearing = (Math.atan2((b[0] - a[0]) * KX, (b[1] - a[1]) * KY) * 180) / Math.PI;
  return { lngLat: interpolate(track.coords, track.cum, d), bearing };
}

export function boundsOfPoints(points: LngLat[]): [LngLat, LngLat] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}
