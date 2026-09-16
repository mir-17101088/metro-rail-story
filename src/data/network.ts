import raw from './network.json';
import type { LineId } from './lines';

export type FeatureId =
  | '6-operational'
  | '6-extension'
  | '1-trunk'
  | '1-branch'
  | '5N-trunk'
  | '5S-trunk'
  | '2-trunk'
  | '2-branch'
  | '4-trunk';

export type LngLat = [number, number];

export interface LineFeature {
  type: 'Feature';
  properties: { id: FeatureId; line: LineId; part: string; lengthM: number };
  geometry: { type: 'LineString'; coordinates: LngLat[] };
}

export interface StationProps {
  id: string;
  name: string;
  lines: LineId[];
  primary: LineId;
  interchange: boolean;
  terminus: boolean;
  depth: 'underground' | 'elevated' | 'mixed' | 'unspecified';
  depthByLine: Partial<Record<LineId, string>>;
  on: Array<{ feature: FeatureId; progress: number }>;
}

export interface StationFeature {
  type: 'Feature';
  id: number;
  properties: StationProps;
  geometry: { type: 'Point'; coordinates: LngLat };
}

export interface UndergroundFeature {
  type: 'Feature';
  properties: { line: LineId; feature: FeatureId; from: number; to: number; lengthKm: number };
  geometry: { type: 'LineString'; coordinates: LngLat[] };
}

export interface Network {
  lines: { type: 'FeatureCollection'; features: LineFeature[] };
  underground: { type: 'FeatureCollection'; features: UndergroundFeature[] };
  stations: { type: 'FeatureCollection'; features: StationFeature[] };
  badges: {
    type: 'FeatureCollection';
    features: Array<{ type: 'Feature'; properties: { line: LineId; station: string }; geometry: { type: 'Point'; coordinates: LngLat } }>;
  };
  train: { lengthM: number; path: LngLat[]; cumulativeM: number[]; stops: Array<{ name: string; along: number }> };
}

export const network = raw as unknown as Network;

export const ALL_FEATURES: FeatureId[] = [
  '6-operational',
  '6-extension',
  '1-trunk',
  '1-branch',
  '5N-trunk',
  '5S-trunk',
  '2-trunk',
  '2-branch',
  '4-trunk',
];

export const featureById = new Map(network.lines.features.map((f) => [f.properties.id, f]));
export const stationById = new Map(network.stations.features.map((f) => [f.properties.id, f]));

export function lineOfFeature(id: FeatureId): LineId {
  return featureById.get(id)!.properties.line;
}

export function featuresOfLine(line: LineId): FeatureId[] {
  return ALL_FEATURES.filter((f) => lineOfFeature(f) === line);
}

/** Stations of a line, ordered along its main feature. */
export function stationsOfLine(line: LineId): StationFeature[] {
  const order = featuresOfLine(line);
  const rank = (s: StationFeature) => {
    let best = Number.POSITIVE_INFINITY;
    for (const o of s.properties.on) {
      const idx = order.indexOf(o.feature);
      if (idx >= 0) best = Math.min(best, idx + o.progress);
    }
    return best;
  };
  return network.stations.features
    .filter((s) => s.properties.lines.includes(line))
    .sort((a, b) => rank(a) - rank(b));
}
