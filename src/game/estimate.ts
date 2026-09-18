import type { LineId } from '../data/lines';
import { network, stationById, type FeatureId } from '../data/network';
import type { Hop, Leg, Route } from './routes';

/**
 * How long a trip takes and what it costs.
 *
 * Line 6 is the only line running, so its published figures are used as they
 * are: DMTCL's fare chart ("MRT-6 Fare.csv") and the running time of each hop
 * ("SIngle station travel time and fare.csv"). Every other ride, and Line 6's
 * Kamlapur extension, is estimated from rules fitted to those two tables:
 *
 * - Distance: each line's drawn track is stretched or shrunk to its official
 *   length (below), so a kilometre means the same thing on every line.
 * - Fare: Tk 4.70 a kilometre, rounded up to the next Tk 10, never below
 *   Tk 20. On Line 6's measured track that rule reproduces 196 of the chart's
 *   240 fares exactly and is never more than Tk 10 off. The chart's summary by
 *   number of stations ("1-2 stations: Tk 20") only works because Line 6's
 *   stations are about 1.3 km apart; Line 2 has gaps of 5 to 6 km.
 * - Time: 1.5 minutes a stop plus 0.67 minutes a kilometre, the least-squares
 *   fit to Line 6's 15 hops. It gives the same 36 minutes for the whole line
 *   and implies a cruising speed of about 90 km/h, under the trains' 100 km/h.
 * - Each line is a separate ticket: no through-fare between lines has been
 *   announced, so a rider taps out and pays, then taps in again.
 * - A change costs a walk between platforms (longer between an elevated and an
 *   underground line) and, on average, half the time between trains.
 *
 * The time does not include the wait for the first train.
 */

/* ------------------------------------------------------------ Line 6 data */

/** Line 6 stations in running order, as in DMTCL's fare chart. */
const LINE6 = [
  'uttara-north',
  'uttara-center',
  'uttara-south',
  'pallabi',
  'mirpur-11',
  'mirpur-10',
  'kazipara',
  'shewrapara',
  'agargaon',
  'bijoy-sarani',
  'farmgate',
  'karwan-bazar',
  'shahbagh',
  'dhaka-university',
  'bangladesh-secretariat',
  'motijheel',
];

/** DMTCL single-journey fares in Tk, row = from, column = to, in LINE6 order (the chart is symmetric). */
const LINE6_FARES: readonly (readonly number[])[] = [
  [0, 20, 20, 30, 30, 40, 40, 50, 60, 60, 70, 80, 80, 90, 90, 100],
  [20, 0, 20, 20, 30, 30, 40, 40, 50, 60, 60, 70, 80, 80, 90, 90],
  [20, 20, 0, 20, 20, 30, 30, 40, 50, 50, 60, 70, 70, 80, 90, 90],
  [30, 20, 20, 0, 20, 20, 20, 30, 40, 40, 50, 60, 60, 70, 80, 80],
  [30, 30, 20, 20, 0, 20, 20, 20, 30, 40, 40, 50, 60, 60, 70, 70],
  [40, 30, 30, 20, 20, 0, 20, 20, 20, 30, 30, 40, 40, 50, 60, 60],
  [40, 40, 30, 20, 20, 20, 0, 20, 20, 20, 30, 30, 40, 40, 50, 60],
  [50, 40, 40, 30, 20, 20, 20, 0, 20, 20, 20, 30, 30, 40, 40, 50],
  [60, 50, 50, 40, 30, 20, 20, 20, 0, 20, 20, 30, 30, 30, 40, 50],
  [60, 60, 50, 40, 40, 30, 20, 20, 20, 0, 20, 20, 30, 30, 40, 50],
  [70, 60, 60, 50, 40, 30, 30, 20, 20, 20, 0, 20, 20, 30, 30, 40],
  [80, 70, 70, 60, 50, 40, 30, 30, 30, 20, 20, 0, 20, 20, 30, 30],
  [80, 80, 70, 60, 60, 40, 40, 30, 30, 30, 20, 20, 0, 20, 20, 30],
  [90, 80, 80, 70, 60, 50, 40, 40, 30, 30, 30, 20, 20, 0, 20, 20],
  [90, 90, 90, 80, 70, 60, 50, 40, 40, 40, 30, 30, 20, 20, 0, 20],
  [100, 90, 90, 80, 70, 60, 60, 50, 50, 50, 40, 30, 30, 20, 20, 0],
];

/**
 * Minutes from each Line 6 station to the next, in LINE6 order. Where the
 * table gives a range ("2.5-3 min"), its middle is used. They add up to the
 * table's 36 minutes from Uttara North to Motijheel.
 */
const LINE6_HOP_MIN = [2, 2, 3, 2, 2, 2, 2, 2.75, 3, 2.5, 2, 3, 2, 2.75, 3];

const line6Index = new Map(LINE6.map((id, i) => [id, i]));

/* -------------------------------------------------------------- the rules */

/** Fitted to Line 6's chart (see above). */
const FARE_PER_KM = 4.7;
const FARE_STEP = 10;
const FARE_MIN = 20;
/** MRT Pass (and Rapid Pass) holders pay 10% less. */
const PASS_DISCOUNT = 0.1;

/** Fitted to Line 6's running times (see above). */
const MIN_PER_STOP = 1.5;
const MIN_PER_KM = 0.67;

/** Line 6 runs about every 8 minutes at peak: a rider arriving at random waits half that. */
export const CHANGE_WAIT_MIN = 4;
/** Platform to platform, including tapping out and in: between levels, on the same level, or where the depth is not decided yet. */
const CHANGE_WALK_MIN = { split: 5, level: 3, unknown: 4 } as const;

/** Official lengths in km, each spread over the stretches of drawn track it covers. */
const PORTAL_5S = network.underground.features.find((f) => f.properties.feature === '5S-trunk')!.properties.to;
const OFFICIAL: Array<{ km: number; stretches: Array<{ feature: FeatureId; from?: number; to?: number }> }> = [
  { km: 20.1, stretches: [{ feature: '6-operational' }] }, // Uttara North to Motijheel
  { km: 1.16, stretches: [{ feature: '6-extension' }] }, // Motijheel to Kamlapur
  { km: 19.87, stretches: [{ feature: '1-trunk' }] }, // underground, Kamlapur to the airport
  { km: 11.37, stretches: [{ feature: '1-branch' }] }, // elevated, Notun Bazar to Purbachal
  { km: 20, stretches: [{ feature: '5N-trunk' }] },
  { km: 12.8, stretches: [{ feature: '5S-trunk', to: PORTAL_5S }] }, // underground
  { km: 17.2 - 12.8, stretches: [{ feature: '5S-trunk', from: PORTAL_5S }] }, // elevated
  { km: 35, stretches: [{ feature: '2-trunk' }, { feature: '2-branch' }] }, // with the Sadarghat branch
  { km: 16, stretches: [{ feature: '4-trunk' }] },
];

/* ------------------------------------------------------------ calibration */

/** Per feature: stretches of track (progress 0-1) and the km each unit of progress is worth there. */
const scales = new Map<FeatureId, Array<{ from: number; to: number; kmPerUnit: number }>>();

for (const { km, stretches } of OFFICIAL) {
  const spans = stretches.map((s) => {
    const stops = stationProgress(s.feature);
    const from = s.from ?? stops[0];
    const to = s.to ?? stops[stops.length - 1];
    const feature = network.lines.features.find((f) => f.properties.id === s.feature)!;
    return { feature: s.feature, from, to, drawnKm: ((to - from) * feature.properties.lengthM) / 1000 };
  });
  const factor = km / spans.reduce((sum, s) => sum + s.drawnKm, 0);
  for (const span of spans) {
    const list = scales.get(span.feature) ?? [];
    list.push({ from: span.from, to: span.to, kmPerUnit: (span.drawnKm * factor) / (span.to - span.from) });
    scales.set(span.feature, list);
  }
}

function stationProgress(feature: FeatureId): number[] {
  return network.stations.features
    .flatMap((s) => s.properties.on.filter((o) => o.feature === feature).map((o) => o.progress))
    .sort((a, b) => a - b);
}

/** Official-length kilometres between two stations on one feature. */
function hopKm(hop: Hop): number {
  const lo = Math.min(hop.fromP, hop.toP);
  const hi = Math.max(hop.fromP, hop.toP);
  let km = 0;
  for (const s of scales.get(hop.feature) ?? []) {
    const overlap = Math.min(hi, s.to) - Math.max(lo, s.from);
    if (overlap > 0) km += overlap * s.kmPerUnit;
  }
  return km;
}

/* ---------------------------------------------------------------- results */

export interface LegEstimate {
  line: LineId;
  from: string;
  to: string;
  stops: number;
  km: number;
  /** Exact, for sums. */
  minutes: number;
  /** Whole minutes, as shown. The trip's total is the sum of these and the changes. */
  shownMinutes: number;
  fare: number;
  passFare: number;
  /** From Line 6's published tables, rather than estimated. */
  published: boolean;
}

export interface ChangeEstimate {
  station: string;
  fromLine: LineId;
  toLine: LineId;
  /** How the two platforms sit: one elevated and one underground, both on one level, or not decided yet. */
  kind: 'down' | 'up' | 'level' | 'unknown';
  walk: number;
  wait: number;
  minutes: number;
  shownMinutes: number;
}

export interface Estimate {
  legs: LegEstimate[];
  changes: ChangeEstimate[];
  km: number;
  /** Whole minutes: the total, and its split into riding and changing (they add up). */
  minutes: number;
  rideMinutes: number;
  changeMinutes: number;
  fare: number;
  passFare: number;
  /** Everything came from Line 6's published tables. */
  published: boolean;
  /** Trip clock at each boarding and each arrival: minutes since leaving, whole. */
  clock: { board: number[]; arrive: number[] };
}

const cache = new Map<string, Estimate>();

export function estimate(route: Route): Estimate {
  const cached = cache.get(route.key);
  if (cached) return cached;

  const legs = route.legs.map(estimateLeg);
  const changes = route.legs.slice(0, -1).map((leg, i) => estimateChange(leg.to, leg.line, route.legs[i + 1].line));

  // Each ride is rounded on its own, so it reads the same inside any trip, and
  // the trip is the sum of what is shown, so the figures always add up.
  const board: number[] = [];
  const arrive: number[] = [];
  let clock = 0;
  legs.forEach((leg, i) => {
    board.push(clock);
    clock += leg.shownMinutes;
    arrive.push(clock);
    clock += changes[i]?.shownMinutes ?? 0;
  });

  const result: Estimate = {
    legs,
    changes,
    km: legs.reduce((sum, l) => sum + l.km, 0),
    minutes: clock,
    rideMinutes: legs.reduce((sum, l) => sum + l.shownMinutes, 0),
    changeMinutes: changes.reduce((sum, c) => sum + c.shownMinutes, 0),
    fare: legs.reduce((sum, l) => sum + l.fare, 0),
    passFare: legs.reduce((sum, l) => sum + l.passFare, 0),
    published: legs.every((l) => l.published),
    clock: { board, arrive },
  };
  cache.set(route.key, result);
  return result;
}

function estimateLeg(leg: Leg): LegEstimate {
  const km = leg.hops.reduce((sum, h) => sum + hopKm(h), 0);
  const a = line6Index.get(leg.from);
  const b = line6Index.get(leg.to);
  const published = leg.line === '6' && a !== undefined && b !== undefined;

  let minutes = 0;
  for (const hop of leg.hops) {
    const i = line6Index.get(hop.from);
    const j = line6Index.get(hop.to);
    minutes += hop.line === '6' && i !== undefined && j !== undefined ? LINE6_HOP_MIN[Math.min(i, j)] : modelMinutes(hopKm(hop));
  }

  let fare = published ? LINE6_FARES[a!][b!] : fareFor(km);
  // A ride on to Kamlapur never costs less than the chart's fare to Motijheel.
  if (leg.line === '6' && !published) {
    const end = a ?? b;
    if (end !== undefined) fare = Math.max(fare, LINE6_FARES[end][line6Index.get('motijheel')!]);
  }

  return {
    line: leg.line,
    from: leg.from,
    to: leg.to,
    stops: leg.hops.length,
    km,
    minutes,
    shownMinutes: Math.round(minutes),
    fare,
    passFare: Math.round(fare * (1 - PASS_DISCOUNT)),
    published,
  };
}

function estimateChange(station: string, fromLine: LineId, toLine: LineId): ChangeEstimate {
  const depth = stationById.get(station)?.properties.depthByLine ?? {};
  const a = depth[fromLine];
  const b = depth[toLine];
  const known = (d?: string) => d === 'elevated' || d === 'underground';
  let kind: ChangeEstimate['kind'] = 'unknown';
  if (known(a) && known(b)) kind = a === b ? 'level' : b === 'underground' ? 'down' : 'up';
  const walk = kind === 'unknown' ? CHANGE_WALK_MIN.unknown : kind === 'level' ? CHANGE_WALK_MIN.level : CHANGE_WALK_MIN.split;
  const minutes = walk + CHANGE_WAIT_MIN;
  return { station, fromLine, toLine, kind, walk, wait: CHANGE_WAIT_MIN, minutes, shownMinutes: minutes };
}

/** Distance fare: Tk 4.70 a km, up to the next Tk 10, at least Tk 20. */
export function fareFor(km: number): number {
  // The small allowance keeps an exact step (say 40.0000001) from tipping into the next one.
  return Math.max(FARE_MIN, Math.ceil((FARE_PER_KM * km) / FARE_STEP - 1e-9) * FARE_STEP);
}

function modelMinutes(km: number): number {
  return MIN_PER_STOP + MIN_PER_KM * km;
}

/* ---------------------------------------------------------------- today */

/** Part of a trip that cannot be ridden yet: where it runs, how far, and the lines it waits for, in travel order. */
export interface Stretch {
  from: string;
  to: string;
  km: number;
  /** '6' here means the Motijheel-Kamlapur extension, which opens with Kamlapur station. */
  lines: LineId[];
}

/**
 * What a trip on the finished network can use of the metro running today:
 * its Line 6 ride, cut back to Motijheel where it runs on to Kamlapur, and
 * the stretches either side that are still road. The handover is always a
 * running Line 6 station: Mirpur 10, Karwan Bazar or Motijheel.
 */
export interface Today {
  ride: LegEstimate;
  before: Stretch | null;
  after: Stretch | null;
}

const todayCache = new Map<string, Today | null>();

/** Null when the trip runs today in full, or has no Line 6 ride that runs today. */
export function today(route: Route): Today | null {
  if (todayCache.has(route.key)) return todayCache.get(route.key)!;
  let result: Today | null = null;
  // A route rides each line at most once.
  const i = route.legs.findIndex((l) => l.line === '6');
  const leg = route.legs[i];
  const running = leg ? leg.hops.filter((h) => h.feature === '6-operational') : [];
  if (running.length) {
    // The extension only touches Motijheel, so the running hops are one unbroken run.
    const first = leg.hops.indexOf(running[0]);
    const last = leg.hops.indexOf(running[running.length - 1]);
    const before = [...route.legs.slice(0, i).flatMap((l) => l.hops), ...leg.hops.slice(0, first)];
    const after = [...leg.hops.slice(last + 1), ...route.legs.slice(i + 1).flatMap((l) => l.hops)];
    if (before.length || after.length) {
      const from = running[0].from;
      const to = running[running.length - 1].to;
      result = {
        ride: estimateLeg({ line: '6', from, to, hops: running, meters: running.reduce((sum, h) => sum + h.meters, 0) }),
        before: stretch(before),
        after: stretch(after),
      };
    }
  }
  todayCache.set(route.key, result);
  return result;
}

function stretch(hops: Hop[]): Stretch | null {
  if (!hops.length) return null;
  return {
    from: hops[0].from,
    to: hops[hops.length - 1].to,
    km: hops.reduce((sum, h) => sum + hopKm(h), 0),
    lines: [...new Set(hops.map((h) => h.line))],
  };
}

/** Minutes to walk a distance at 5 km/h, for comparison. */
export const walkingMinutes = (km: number): number => (km / 5) * 60;
