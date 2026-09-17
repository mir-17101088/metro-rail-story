import { LINES, LINE_ORDER, PLANNING_LINES, type LineId } from '../data/lines';
import { network, stationById, type FeatureId } from '../data/network';

/**
 * Journey planning on the finished six-line network.
 *
 * Stations are nodes; neighbouring stations on a line feature are joined by a
 * hop. A route is a chain of rides, one line each, joined at interchanges.
 * The network is small (80 stations, 6 lines), so every chain of up to four
 * rides is enumerated outright and then pruned to the ones a person would
 * actually consider taking.
 */

export interface Hop {
  from: string;
  to: string;
  line: LineId;
  feature: FeatureId;
  /** Positions along the feature, 0-1. */
  fromP: number;
  toP: number;
  meters: number;
}

export interface Leg {
  line: LineId;
  from: string;
  to: string;
  hops: Hop[];
  meters: number;
}

export interface Route {
  legs: Leg[];
  /** Interchanges where the rider switches lines, in order. */
  changes: string[];
  /** Stations after the first one. */
  stops: number;
  meters: number;
  /** Stable identity: the lines ridden and where they meet. */
  key: string;
}

/** Longest chain considered: three changes. Every pair of stations is reachable well within it. */
export const MAX_LEGS = 4;
/** Options offered at most. */
const MAX_OPTIONS = 3;
/** An extra change is only offered if it shortens the trip by at least this share. */
const CHANGE_MUST_SAVE = 0.1;
/** With the same number of changes, an option may be this much longer than the best... */
const DETOUR_RATIO = 1.35;
/** ...plus this, so short trips can still show a genuine alternative. */
const DETOUR_SLACK_M = 1500;

/* ------------------------------------------------------------------ graph */

const hopsFrom = new Map<string, Hop[]>();
const stationsOnLine = new Map<LineId, string[]>();

for (const feature of network.lines.features) {
  const { id, line, lengthM } = feature.properties;
  const stops = network.stations.features
    .flatMap((s) => s.properties.on.filter((o) => o.feature === id).map((o) => ({ id: s.properties.id, p: o.progress })))
    .sort((a, b) => a.p - b.p);
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const meters = (b.p - a.p) * lengthM;
    addHop({ from: a.id, to: b.id, line, feature: id, fromP: a.p, toP: b.p, meters });
    addHop({ from: b.id, to: a.id, line, feature: id, fromP: b.p, toP: a.p, meters });
  }
}

for (const line of LINE_ORDER) {
  stationsOnLine.set(
    line,
    network.stations.features.filter((s) => s.properties.lines.includes(line)).map((s) => s.properties.id),
  );
}

function addHop(hop: Hop): void {
  const list = hopsFrom.get(hop.from) ?? [];
  list.push(hop);
  hopsFrom.set(hop.from, list);
}

export const linesAt = (station: string): LineId[] => stationById.get(station)?.properties.lines ?? [];

/* ------------------------------------------------------------------- rides */

const rideCache = new Map<string, Leg | null>();

/** The ride between two stations on one line (a line is a tree, so there is exactly one). */
function ride(line: LineId, from: string, to: string): Leg | null {
  const key = `${line}|${from}|${to}`;
  if (rideCache.has(key)) return rideCache.get(key)!;

  const previous = new Map<string, Hop>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const at = queue.shift()!;
    if (at === to) break;
    for (const hop of hopsFrom.get(at) ?? []) {
      if (hop.line !== line || seen.has(hop.to)) continue;
      seen.add(hop.to);
      previous.set(hop.to, hop);
      queue.push(hop.to);
    }
  }

  let leg: Leg | null = null;
  if (from !== to && previous.has(to)) {
    const hops: Hop[] = [];
    for (let at = to; at !== from; at = previous.get(at)!.from) hops.unshift(previous.get(at)!);
    leg = { line, from, to, hops, meters: hops.reduce((sum, h) => sum + h.meters, 0) };
  }
  rideCache.set(key, leg);
  return leg;
}

/* ------------------------------------------------------------------ routes */

/**
 * Every sensible way from one station to another, best first: fewest changes,
 * then shortest distance. Empty when the stations are the same or unconnected
 * (for instance when every line that reaches them is in `avoid`).
 */
export function findRoutes(from: string, to: string, { avoid = [] as LineId[] } = {}): Route[] {
  if (from === to || !stationById.has(from) || !stationById.has(to)) return [];

  const destinationLines = linesAt(to);
  const candidates: Leg[][] = [];

  const explore = (at: string, legs: Leg[], used: Set<LineId>) => {
    for (const line of linesAt(at)) {
      if (used.has(line) || avoid.includes(line)) continue;
      if (destinationLines.includes(line)) {
        const last = ride(line, at, to);
        if (last) candidates.push([...legs, last]);
      }
      if (legs.length + 1 >= MAX_LEGS) continue;
      used.add(line);
      for (const next of stationsOnLine.get(line) ?? []) {
        if (next === at || next === to || linesAt(next).length < 2) continue;
        const leg = ride(line, at, next);
        if (leg) explore(next, [...legs, leg], used);
      }
      used.delete(line);
    }
  };
  explore(from, [], new Set());

  // One option per sequence of lines: the shortest place to make each change.
  const bySequence = new Map<string, Route>();
  for (const legs of candidates) {
    if (!sensible(legs)) continue;
    const route = toRoute(legs);
    const sequence = legs.map((l) => l.line).join('>');
    const best = bySequence.get(sequence);
    if (!best || route.meters < best.meters) bySequence.set(sequence, route);
  }

  // Lines running side by side (6 and 2, 2 and 4) give near-identical trips
  // with the same changes: keep the one that can be ridden soonest.
  const byChanges = new Map<string, Route>();
  for (const route of bySequence.values()) {
    const key = route.changes.join('>');
    const other = byChanges.get(key);
    const sooner = other ? readyOrder(route) - readyOrder(other) || route.meters - other.meters : -1;
    if (sooner < 0) byChanges.set(key, route);
  }

  const ranked = [...byChanges.values()].sort(
    (a, b) => a.changes.length - b.changes.length || a.meters - b.meters,
  );

  const kept: Route[] = [];
  for (const route of ranked) {
    if (kept.length === MAX_OPTIONS) break;
    const fewer = shortest(kept.filter((k) => k.changes.length < route.changes.length));
    const same = shortest(kept.filter((k) => k.changes.length === route.changes.length));
    if (route.meters > fewer * (1 - CHANGE_MUST_SAVE)) continue;
    if (route.meters > same * DETOUR_RATIO + DETOUR_SLACK_M) continue;
    kept.push(route);
  }
  return kept;
}

/**
 * For a trip that needs a line still being planned: the best route that can be
 * given a date, avoiding every such line. Null when the planned lines are the
 * only way there.
 */
export function findDatedRoute(from: string, to: string): Route | null {
  return findRoutes(from, to, { avoid: PLANNING_LINES })[0] ?? null;
}

const shortest = (routes: Route[]): number =>
  routes.length ? Math.min(...routes.map((r) => r.meters)) : Number.POSITIVE_INFINITY;

function toRoute(legs: Leg[]): Route {
  const changes = legs.slice(0, -1).map((l) => l.to);
  return {
    legs,
    changes,
    stops: legs.reduce((sum, l) => sum + l.hops.length, 0),
    meters: legs.reduce((sum, l) => sum + l.meters, 0),
    key: legs.map((l) => `${l.line}:${l.from}`).join('|') + `|${legs[legs.length - 1].to}`,
  };
}

/**
 * Rejects chains nobody would ride:
 * - passing through the same station twice;
 * - boarding, changing or arriving at a station that is also on a line used
 *   elsewhere in the trip (you could have switched there directly);
 * - riding through a station on a line two or more rides away, for the same
 *   reason. Neighbouring rides may share stations: lines that run side by side
 *   (Line 2 and Line 6 at Motijheel and Kamlapur) offer several places to change,
 *   and the shortest one wins.
 */
function sensible(legs: Leg[]): boolean {
  const lines = legs.map((l) => l.line);

  const visited = new Set([legs[0].from]);
  for (const leg of legs) {
    for (const hop of leg.hops) {
      if (visited.has(hop.to)) return false;
      visited.add(hop.to);
    }
  }

  const points = [legs[0].from, ...legs.map((l) => l.to)];
  for (let m = 0; m < points.length; m++) {
    const served = linesAt(points[m]);
    for (let j = 0; j < lines.length; j++) {
      if (j !== m - 1 && j !== m && served.includes(lines[j])) return false;
    }
  }

  for (let i = 0; i < legs.length; i++) {
    const hops = legs[i].hops;
    for (let h = 0; h < hops.length - 1; h++) {
      const served = linesAt(hops[h].to);
      for (let j = 0; j < lines.length; j++) {
        if (Math.abs(i - j) >= 2 && served.includes(lines[j])) return false;
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------- readiness */

export type Readiness =
  | { kind: 'running' }
  | { kind: 'kamlapur' }
  | { kind: 'future'; line: LineId; year: number; month: number; lines: LineId[] }
  | { kind: 'planning'; lines: LineId[] };

/**
 * When the whole trip can be made. A line still being planned has no date,
 * so neither does any trip that needs it. Otherwise it is the latest deadline
 * among the trip's lines. A Line 6 trip is possible today, unless it uses the
 * Kamlapur extension.
 */
export function readiness(route: Route): Readiness {
  const lines = [...new Set(route.legs.map((l) => l.line))];
  const planning = lines.filter((line) => LINES[line].completion === 'planning');
  if (planning.length) return { kind: 'planning', lines: planning };

  const future = lines.filter((line) => typeof LINES[line].completion === 'object');
  if (!future.length) {
    const kamlapur = route.legs.some((l) => l.hops.some((h) => h.feature === '6-extension'));
    return kamlapur ? { kind: 'kamlapur' } : { kind: 'running' };
  }
  const deadline = (line: LineId) => LINES[line].completion as { year: number; month: number };
  const order = (line: LineId) => deadline(line).year * 12 + deadline(line).month;
  const last = future.reduce((a, b) => (order(b) > order(a) ? b : a));
  const { year, month } = deadline(last);
  return { kind: 'future', line: last, year, month, lines: future };
}

/** Sortable readiness: running today, then Kamlapur's opening, then each deadline in date order, then no date. */
function readyOrder(route: Route): number {
  const ready = readiness(route);
  if (ready.kind === 'running') return 0;
  if (ready.kind === 'kamlapur') return 1;
  if (ready.kind === 'planning') return Number.POSITIVE_INFINITY;
  return ready.year * 12 + ready.month;
}
