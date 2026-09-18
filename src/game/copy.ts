import { KAMLAPUR_OPENING, LINES, type LineId } from '../data/lines';
import { stationById } from '../data/network';
import { estimate, today, walkingMinutes, type Estimate, type Stretch, type Today } from './estimate';
import { readiness, type Leg, type Readiness, type Route } from './routes';

/**
 * Every line of text the route game shows. Editors can change the wording
 * here without touching the game logic. Where a list offers several lines,
 * they are dealt like cards (see `pick`), so replays keep reading differently.
 * Every figure in them comes from `estimate` (./estimate.ts), so wording can
 * change freely without the numbers drifting.
 *
 * Text wrapped in {{double braces}} is kept on one line when shown (so
 * "MRT Line-5 (South)" never breaks at its hyphen); see `toHtml` and `toPlain`.
 *
 * Every time and fare that is an estimate reads "~42 min", "~Tk 80" (see
 * `approx`). Only Line 6's published figures, between its running stations,
 * are shown bare. The text never says how an estimate was worked out.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

/** Per list: the items still to come this round, and the last one shown. */
const decks = new WeakMap<readonly unknown[], { left: number[]; last: number }>();

/**
 * A random item, dealt like a card: every item in the list comes up once
 * before any repeats, and never the same one twice in a row.
 */
export function pick<T>(list: readonly T[]): T {
  if (list.length < 2) return list[0];
  let deck = decks.get(list);
  if (!deck) decks.set(list, (deck = { left: [], last: -1 }));
  if (!deck.left.length) {
    const order = [...list.keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // Dealt from the end: the last item of the round before must not come straight back.
    const end = order.length - 1;
    if (order[end] === deck.last) [order[0], order[end]] = [order[end], order[0]];
    deck.left = order;
  }
  deck.last = deck.left.pop()!;
  return list[deck.last];
}

export const stationName = (id: string): string => stationById.get(id)?.properties.name ?? id;

/** "Line 5 North", as in the network explorer. */
export const lineName = (line: LineId): string => LINES[line].name;

const keep = (s: string) => `{{${s}}}`;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Marks an estimate: "~42 min". Screen readers hear "about 42 min" (see `toHtml` and `toPlain`). */
const APPROX = '~';

/**
 * Escaped HTML, with {{kept}} phrases unbreakable, and each estimate's tilde
 * shown but spoken as "about" (a screen reader would otherwise say "tilde").
 */
export const toHtml = (s: string): string =>
  esc(s)
    .replace(/\{\{(.+?)\}\}/g, '<span class="nobr">$1</span>')
    .replaceAll(APPROX, '<span aria-hidden="true">~</span><span class="visually-hidden">about </span>');

/** For screen reader announcements. */
export const toPlain = (s: string): string => s.replace(/\{\{|\}\}/g, '').replaceAll(APPROX, 'about ');

/** "MRT Line-5 (North)", as in the project names. */
export function projectName(line: LineId): string {
  if (line === '5N') return keep('MRT Line-5 (North)');
  if (line === '5S') return keep('MRT Line-5 (South)');
  return keep(`MRT Line-${line}`);
}

const NB = '\u00a0';

/** Non-breaking, so "10 stops" or "Dec 2035" never splits across lines. */
const plural = (n: number, one: string, many = `${one}s`) => `${n}${NB}${n === 1 ? one : many}`;

export const stops = (n: number): string => plural(n, 'stop');

export const changes = (n: number): string => (n ? plural(n, 'change') : `No${NB}changes`);

const listOf = (items: string[]): string =>
  items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export const listNames = (ids: string[]): string => listOf(ids.map(stationName));

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five'];
const word = (n: number) => WORDS[n] ?? String(n);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* -------------------------------------------------------------- figures */

/** "42 min", "1 hr 8 min". */
export function duration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m}${NB}min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}${NB}hr ${rest}${NB}min` : `${h}${NB}hr`;
}

/** For comparisons, where minutes would be false precision: past the hour, to the nearest 5 minutes. */
const rough = (minutes: number): number => (minutes < 60 ? Math.round(minutes) : Math.round(minutes / 5) * 5);

/** House style: "Tk 1,250", never the ৳ sign (the story's fonts do not carry it). */
export const taka = (n: number): string => `Tk${NB}${n.toLocaleString('en-US')}`;

/**
 * A time or fare as shown: bare when it comes from Line 6's published tables
 * (`exact`), "~" in front when it is an estimate. Walking and road times are
 * always estimates.
 */
const approx = (figure: string, exact = false): string => (exact ? figure : `${APPROX}${figure}`);

const kmText = (km: number): string => `${km.toFixed(1)}${NB}km`;

/** Workdays in a month, Sunday to Thursday. */
const WORKDAYS = 22;
/** Dhaka's average road speed, km/h: World Bank, 2017. It warned of 4 km/h by 2035. */
const ROAD_KMH = 7;
const ROAD_KMH_2035 = 4;

const thisYear = () => new Date().getFullYear();

/* ------------------------------------------------------------- prompts */

export const HINT = {
  idle: 'Pick two stations. Or tap them on the map.',
  idleNoMap: 'Pick two stations to plan a trip.',
  fromOnly: [
    'Good start. Now, where to?',
    'Nice pick. Where are you headed?',
    'Starting point locked in. Where to?',
    'Tapped in, so to speak. Where to?',
  ],
  toOnly: [
    'Great destination. Where are you starting from?',
    'Lovely spot. And where are you coming from?',
    'Destination set. Where does the trip begin?',
  ],
} as const;

/* ------------------------------------------------------------- options */

export interface Heading {
  title: string;
  text: string;
}

const OPTIONS_TITLES: Array<(n: string) => string> = [
  (n) => `${n} ways to get there`,
  (n) => `${n} routes on the table`,
  (n) => `${n} ways to ride it`,
];

/** "the route via Karwan Bazar", "the direct Line 6 ride". */
const routeRef = (route: Route): string =>
  route.changes.length ? `the route via ${listNames(route.changes)}` : `the direct ${lineName(route.legs[0].line)} ride`;

type Compare = (fast: string, cheap: string, minutes: string, fare: string) => string;

const BOTH_WINS: Array<(r: string, count: number) => string> = [
  (r) => `${capital(r)} is quickest and cheapest. Easy choice.`,
  (r) => `One route wins on time and fare: ${r}.`,
  (r, count) => `${capital(r)} is fastest and cheapest. ${count > 2 ? 'The others are' : 'The other one is'} just for show.`,
];

const TRADE_OFFS: Compare[] = [
  (fast, cheap, minutes, fare) => `Time or money? ${capital(fast)} is ${minutes} quicker; ${cheap} is ${fare} cheaper.`,
  (fast, cheap, minutes, fare) => `${capital(fast)} saves ${minutes}. ${capital(cheap)} saves ${fare}. Your call.`,
  (fast, cheap, minutes, fare) => `Speed costs ${fare} extra: ${fast} beats ${cheap} by ${minutes}.`,
];

const SAME_FARE: Array<(fast: string, minutes: string) => string> = [
  (fast, minutes) => `Same fare whichever you pick, but ${fast} gets you there ${minutes} sooner.`,
  (fast, minutes) => `The fares tie. The clock doesn't: ${fast} is ${minutes} quicker.`,
];

const SAME_TIME: Array<(cheap: string, fare: string) => string> = [
  (cheap, fare) => `Same time either way, but ${cheap} saves you ${fare}.`,
  (cheap, fare) => `The clock can't split them. Your wallet can: ${cheap} is ${fare} cheaper.`,
];

const DEAD_HEAT = ['Same time, same fare. Flip a coin.', 'A dead heat on time and fare. Go with your gut.'];

/** Neither time nor fare picks a single winner. */
const TOO_CLOSE = ["Too close to call on time or fare. They're listed fewest changes first.", 'No clear winner on the clock or the wallet. Fewest changes first.'];

/** Index of the single smallest value, or -1 when it is shared. */
function onlyLowest(values: number[]): number {
  const low = Math.min(...values);
  const at = values.flatMap((v, i) => (v === low ? [i] : []));
  return at.length === 1 ? at[0] : -1;
}

/** Second smallest distinct value minus the smallest (0 when all are equal). */
function lead(values: number[]): number {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  return distinct.length > 1 ? distinct[1] - distinct[0] : 0;
}

/**
 * The note after a winning route that needs a line with no date, when another
 * route does not. `who` names it where two routes were just mentioned.
 */
function paperCatch(route: Route, routes: Route[], who = 'it'): string {
  const ready = readiness(route);
  if (ready.kind !== 'planning' || routes.every((r) => readiness(r).kind === 'planning')) return '';
  return ` Catch: ${who} needs ${listOf(ready.lines.map(lineName))}, still on paper.`;
}

/** Heading over the list of routes: how many, and how they compare on time and fare. */
export function optionsHeading(routes: Route[]): Heading {
  const title = pick(OPTIONS_TITLES)(capital(word(routes.length)));
  const est = routes.map(estimate);
  const minutes = est.map((e) => e.minutes);
  const fares = est.map((e) => e.fare);
  const fast = onlyLowest(minutes);
  const cheap = onlyLowest(fares);
  // A gap between two figures is only exact when both are.
  const exact = est.every((e) => e.published);
  const mins = (m: number) => approx(duration(m), exact);
  const tk = (n: number) => approx(taka(n), exact);

  let text: string;
  if (fast >= 0 && fast === cheap) {
    text = pick(BOTH_WINS)(routeRef(routes[fast]), routes.length) + paperCatch(routes[fast], routes);
  } else if (fast >= 0 && cheap >= 0) {
    text =
      pick(TRADE_OFFS)(
        routeRef(routes[fast]),
        routeRef(routes[cheap]),
        mins(minutes[cheap] - minutes[fast]),
        tk(fares[fast] - fares[cheap]),
      ) + paperCatch(routes[fast], routes, 'the quicker one');
  } else if (fast >= 0) {
    text = fares.every((f) => f === fares[0])
      ? pick(SAME_FARE)(routeRef(routes[fast]), mins(lead(minutes)))
      : `${capital(routeRef(routes[fast]))} is quickest, by ${mins(lead(minutes))}.`;
    text += paperCatch(routes[fast], routes);
  } else if (cheap >= 0) {
    text = minutes.every((m) => m === minutes[0])
      ? pick(SAME_TIME)(routeRef(routes[cheap]), tk(lead(fares)))
      : `${capital(routeRef(routes[cheap]))} is cheapest, by ${tk(lead(fares))}.`;
  } else {
    const flat = minutes.every((m) => m === minutes[0]) && fares.every((f) => f === fares[0]);
    text = pick(flat ? DEAD_HEAT : TOO_CLOSE);
  }
  return { title, text };
}

/** Per route: "Fastest" and "Cheapest", when one route alone is. */
export function routeTags(routes: Route[]): string[][] {
  const est = routes.map(estimate);
  const fast = onlyLowest(est.map((e) => e.minutes));
  const cheap = onlyLowest(est.map((e) => e.fare));
  return routes.map((_, i) => [...(i === fast ? ['Fastest'] : []), ...(i === cheap ? ['Cheapest'] : [])]);
}

export function routeName(route: Route): string {
  return route.changes.length ? `Via ${listNames(route.changes)}` : `Direct on ${lineName(route.legs[0].line)}`;
}

export function routeMeta(route: Route): string {
  return `${changes(route.changes.length)} · ${stops(route.stops)} · ${readyShort(route)}`;
}

/** The time and fare shown on a route's button. */
export function routeFigures(route: Route): { time: string; fare: string } {
  const e = estimate(route);
  return { time: approx(duration(e.minutes), e.published), fare: approx(taka(e.fare), e.published) };
}

function readyShort(route: Route): string {
  const ready = readiness(route);
  if (ready.kind === 'running') return `Running${NB}now`;
  if (ready.kind === 'kamlapur') return `Early${NB}2027`;
  if (ready.kind === 'planning') return `No${NB}date${NB}yet`;
  return `${MONTHS_SHORT[ready.month - 1]}${NB}${ready.year}`;
}

/* ------------------------------------------------------------- captions */

export interface Caption {
  lines: LineId[];
  title: string;
  text: string;
  /**
   * Trip clock while this caption shows, whole minutes: from `from` to `to`,
   * out of `total`, which is an estimate unless `exact`.
   */
  clock: { from: number; to: number; total: number; exact: boolean };
  /** Short figures after the clock: "~Tk 80 ticket". */
  figures: string[];
}

/** Every caption of one ride, written once when it starts so they stay put while it plays. */
export interface RideScript {
  board: Caption[];
  change: Caption[];
}

const FIRST_BOARD: Array<(station: string) => string> = [
  (s) => `All aboard at ${s}`,
  (s) => `Doors closing at ${s}`,
  (s) => `Departing ${s}`,
  (s) => `Tapped in at ${s}`,
];

const NEXT_BOARD: Array<(line: string) => string> = [
  (l) => `Now riding ${l}`,
  (l) => `Aboard ${l}`,
  (l) => `Onward on ${l}`,
];

const LAST_BOARD: Array<(line: string) => string> = [
  (l) => `Last leg: ${l}`,
  (l) => `Home stretch on ${l}`,
  (l) => `Final ride: ${l}`,
];

const CHANGE_TITLES: Array<(station: string) => string> = [
  (s) => `Change at ${s}`,
  (s) => `All change at ${s}`,
  (s) => `${s}: time to switch`,
];

/** What changing lines looks like, by how the two platforms sit. */
const DOWN = [
  'From the viaduct down to the tunnels.',
  'Sky to subway: escalators all the way down.',
  'Going underground. Way underground.',
  'Trade the skyline for the tunnel.',
];
const UP = ['Up from the tunnels into daylight.', 'Escalators up. Sunshine ahead.', 'Subway to skyway.', 'Surface, then keep climbing.'];
const UNDER = ['Tunnel to tunnel, no daylight required.', 'Same depth, different line: a short walk.', 'Stay underground; the next platform is close.'];
const LEVEL = ['Same level, different line: a short walk.', 'A quick platform swap.', 'Mind the gap.'];
const UNDECIDED = [
  'Where these platforms go is still being decided.',
  'Follow the signs, once someone puts them up.',
  'Platform position: to be announced.',
  'Mind the gap. And the planning gap.',
];

const SWITCH_TO: Array<(line: string) => string> = [(l) => `Switch to ${l}.`, (l) => `Next up: ${l}.`, (l) => `Follow the signs for ${l}.`];

/**
 * At the station where the part of the trip that runs today ends: the ride
 * goes on in the future, the rider today goes on by road. `due` is null for a
 * line with no deadline.
 */
const METRO_ENDS_HERE: Array<(line: string, due: string | null) => string> = [
  (l, d) => `For now, the metro ends here. Once ${l} opens${d ? ` (due ${d})` : ''}, switch here.`,
  (l, d) => `Today you'd step off here and flag down a rickshaw. ${d ? `${l} is due ${d}.` : `${l} has no date yet.`}`,
  (l, d) => `End of today's metro. ${l} picks up from here${d ? `, due ${d}` : ', someday'}.`,
];

/** Where the part of the trip that runs today begins: everything before it is future track. */
const METRO_STARTS_HERE = [
  'Everything so far is future track. From here, Line 6 runs today.',
  "Today, this is where you'd join the metro. Switch to Line 6.",
  "From here on, you're on a line that runs today. Switch to Line 6.",
];

/** "Aug 2033", or null for a line with no deadline. */
function dueShort(line: LineId): string | null {
  const c = LINES[line].completion;
  return typeof c === 'object' ? `${MONTHS_SHORT[c.month - 1]}${NB}${c.year}` : null;
}

/** On a trip that runs only in part today: which of its rides run now, and when the others are due. */
function rideStatus(leg: Leg): string | null {
  if (leg.line === '6') {
    if (!leg.hops.some((h) => h.feature === '6-extension')) return 'Runs today';
    return leg.to === 'kamlapur' ? 'Runs today as far as Motijheel' : 'Runs today from Motijheel';
  }
  const due = dueShort(leg.line);
  // A line with no deadline already says "still on paper".
  return due ? `Due ${due}` : null;
}

export function rideScript(route: Route): RideScript {
  const e = estimate(route);
  const now = today(route);
  const last = route.legs.length - 1;
  const total = e.minutes;
  const several = route.legs.length > 1;

  const board = route.legs.map((leg, i): Caption => {
    const next = i < last ? `to change at ${stationName(leg.to)}` : `to ${stationName(leg.to)}`;
    // A line with no deadline yet only exists on paper.
    const line = LINES[leg.line].completion === 'planning' ? `${lineName(leg.line)} (still on paper)` : lineName(leg.line);
    const title =
      i === 0
        ? pick(FIRST_BOARD)(stationName(leg.from))
        : pick(i === last ? LAST_BOARD : NEXT_BOARD)(lineName(leg.line));
    const fare = approx(taka(e.legs[i].fare), e.legs[i].published);
    const status = now ? rideStatus(leg) : null;
    return {
      lines: [leg.line],
      title,
      text: `${line} · ${stops(leg.hops.length)} ${next}`,
      clock: { from: e.clock.board[i], to: e.clock.arrive[i], total, exact: e.published },
      figures: [several ? `${fare} ticket` : `Fare ${fare}`, ...(status ? [status] : [])],
    };
  });

  const change = e.changes.map((c, i): Caption => {
    const depth = stationById.get(c.station)?.properties.depthByLine ?? {};
    const scene =
      c.kind === 'down'
        ? DOWN
        : c.kind === 'up'
          ? UP
          : c.kind === 'level'
            ? depth[c.fromLine] === 'underground'
              ? UNDER
              : LEVEL
            : UNDECIDED;
    const legsSoFar = e.legs.slice(0, i + 1);
    const paid = approx(
      taka(legsSoFar.reduce((sum, l) => sum + l.fare, 0)),
      legsSoFar.every((l) => l.published),
    );
    // Where today's Line 6 ride ends or begins (never Kamlapur: today's ride stops at Motijheel).
    const ends = Boolean(now?.after) && c.fromLine === '6' && now!.ride.to === c.station;
    const starts = Boolean(now?.before) && c.toLine === '6' && now!.ride.from === c.station;
    const text = ends
      ? pick(METRO_ENDS_HERE)(lineName(c.toLine), dueShort(c.toLine))
      : starts
        ? pick(METRO_STARTS_HERE)
        : `${pick(scene)} ${pick(SWITCH_TO)(lineName(c.toLine))}`;
    return {
      lines: [c.fromLine, c.toLine],
      title: pick(CHANGE_TITLES)(stationName(c.station)),
      text,
      clock: { from: e.clock.arrive[i], to: e.clock.board[i + 1], total, exact: e.published },
      figures: [`${paid} paid so far`, `${approx(duration(c.shownMinutes))} to change`],
    };
  });

  return { board, change };
}

/* -------------------------------------------------------------- results */

export const STAT_LABELS = { time: 'Travel time', fare: 'Fare', steps: 'Leg by leg' } as const;

export interface Stat {
  value: string;
  note: string;
}

/** One row of a trip with changes, leg by leg. */
export interface Step {
  line: LineId | null;
  text: string;
  detail: string;
  time: string;
  fare: string;
}

export interface Figures {
  time: Stat;
  fare: Stat;
  /** A line about the numbers, different from trip to trip. */
  quip: string;
  /** Where the numbers come from, in small print. */
  basis: string;
  /** Leg by leg, for trips with changes. */
  steps: Step[];
  /** "1 change · 14 stops · 19.5 km". */
  meta: string;
}

export interface Note {
  title: string;
  text: string;
}

export interface Result {
  kicker: string;
  title: string;
  text: string;
  figures?: Figures;
  /** What of the trip can be ridden today, when it runs only in part. */
  today?: Note;
}

const RUNNING_QUIPS = [
  "It's already running. No deadline required.",
  'The trains are running today. Mind the rush hour.',
  'No waiting on this one. Just tap in.',
  'Open for business. Bring your MRT Pass.',
];

const DEADLINE_QUIPS = ['Deadlines permitting.', 'Mark your calendar. In pencil.', 'Pack some patience.', 'Set a reminder. A long one.'];

/** A trip that needs a line with no date, when a route with a date is offered below it. */
const PLANNING_QUIPS = [
  "Don't hold your breath. The route below at least comes with a date.",
  'Consider this a sneak preview. For a route with an actual deadline, look below.',
  'File this one under someday. The route below is filed under a year.',
];

/**
 * A trip that needs a line with no date, when no metro route avoids it. Only
 * the metro is missing: buses, rickshaws and feet still make the trip today.
 */
const NO_METRO_YET = [
  'No other metro route gets you there, either. Until one does, the bus, the rickshaw and your own two feet are still on duty.',
  "For now, no metro route of any kind makes this trip. Keep your rickshaw fare handy; the road isn't going anywhere.",
  "Until then, no train goes this way. Dhaka's buses and rickshaws remain undefeated on this route.",
  'No metro alternative exists in the meantime. The road still does, horns and all.',
];

/**
 * The result card for a finished ride. `alternative` is the best route that
 * avoids lines still being planned, when the ride itself needed one.
 */
export function routeResult(route: Route, alternative: Route | null = null): Result {
  const from = stationName(route.legs[0].from);
  const to = stationName(route.legs[route.legs.length - 1].to);
  const ready = readiness(route);
  const kicker = `Arrived at ${to}`;
  const figures = journeyFigures(route);
  const note = todayNote(route) ?? undefined;
  // Where part of the trip runs today, that note carries the voice; the quip after the date steps aside.
  const aside = (quips: readonly string[]) => (note ? '' : ` ${pick(quips)}`);

  if (ready.kind === 'planning') {
    const lines = listOf(ready.lines.map(projectName));
    const one = ready.lines.length === 1;
    return {
      kicker: `${kicker}, on paper`,
      title: `You'll be able to ride the metro from ${from} to ${to} once ${lines} ${one ? 'leaves' : 'leave'} the drawing board.`,
      // With a route below, its quip points there, so it stays.
      text: `${one ? `${lines} is` : 'Both lines are'} still in the planning stage, with no completion deadline yet.${alternative ? ` ${pick(PLANNING_QUIPS)}` : aside(NO_METRO_YET)}`,
      figures,
      today: note,
    };
  }

  if (ready.kind === 'running') {
    return {
      kicker,
      title: `You can just take ${projectName('6')} to reach ${to} from ${from}.`,
      text: pick(RUNNING_QUIPS),
      figures,
    };
  }

  if (ready.kind === 'kamlapur') {
    return {
      kicker,
      title: `You can take ${projectName('6')} to reach ${to} from ${from} by ${KAMLAPUR_OPENING}.`,
      text: "That's when Kamlapur station is due to open. It is 77.2% built.",
      figures,
      today: note,
    };
  }

  const date = `${MONTHS[ready.month - 1]} ${ready.year}`;
  const years = ready.year - thisYear();
  const when = years > 1 ? `, ${years} years from now` : years === 1 ? ', a year from now' : '';
  const line = projectName(ready.line);
  const reason =
    ready.lines.length > 1
      ? `That's when ${line}, the last line on your trip, is due to be finished${when}.`
      : `That's the completion deadline for ${line}${when}.`;
  return {
    kicker,
    title: `You'll be able to ride the metro from ${from} to ${to} by ${keep(date)}.`,
    text: `${reason}${aside(DEADLINE_QUIPS)}`,
    figures,
    today: note,
  };
}

/* ---------------------------------------------------------------- today */

/**
 * Line 6 runs today, so a trip that needs it and a line still to come can be
 * made in part now: Line 6 to or from the interchange where the future line
 * meets it (Mirpur 10, Karwan Bazar or Motijheel), and the road for the rest.
 * Trips on to Kamlapur hand over at Motijheel until Kamlapur station opens.
 */

/** Everything the notes below can say about a trip that runs in part today. */
interface Handover {
  /** Today's Line 6 ride: where it starts and ends, how long, what it costs. */
  a: string;
  b: string;
  aId: string;
  bId: string;
  time: string;
  fare: string;
  covered: string;
  /** Share of the trip's distance that runs today, per cent. */
  share: number;
  origin: string;
  dest: string;
  before: Gap | null;
  after: Gap | null;
  /** Every line the road stretches wait for. */
  waits: Waits;
}

interface Waits {
  /** "Line 5 South (due August 2033) and Line 2 (no date yet)". */
  names: string;
  verb: 'opens' | 'open';
}

interface Gap extends Waits {
  km: string;
  /** Walking time, for a stretch short enough to walk: "~14 min". */
  walk: string | null;
  /** The distance, with the walk when there is one: "1.2 km (~14 min on foot)". */
  far: string;
  /** What covers it today, sized to the distance: "a bus or rickshaw", "buses and rickshaws". */
  vehicle: string;
  vehicles: string;
}

/** Stretches this short get a walking time. */
const WALKABLE_KM = 2.5;
/** Past this, nobody takes a rickshaw: it's a bus or a CNG. */
const RICKSHAW_KM = 6;

function waitsFor(lines: LineId[]): Waits {
  const items = lines.map((line) => {
    // On a road stretch, Line 6 can only be its extension to Kamlapur.
    if (line === '6') return `Kamlapur station (due ${KAMLAPUR_OPENING})`;
    const c = LINES[line].completion;
    if (c === 'planning') return `${lineName(line)} (no date yet)`;
    if (c === 'running') return lineName(line);
    return `${lineName(line)} (due ${MONTHS[c.month - 1]} ${c.year})`;
  });
  return { names: listOf(items), verb: items.length === 1 ? 'opens' : 'open' };
}

/** Each distance rounded on its own, so a stretch reads the same in any trip. */
const tenth = (km: number) => Math.round(km * 10) / 10;

function gap(s: Stretch | null): Gap | null {
  if (!s) return null;
  const km = tenth(s.km);
  const walk = km <= WALKABLE_KM ? approx(duration(rough(walkingMinutes(km)))) : null;
  const [vehicle, vehicles] =
    km <= WALKABLE_KM
      ? ['your feet or a rickshaw', 'feet and rickshaws']
      : km <= RICKSHAW_KM
        ? ['a bus or rickshaw', 'buses and rickshaws']
        : ['a bus or CNG', 'buses and CNGs'];
  return { ...waitsFor(s.lines), km: kmText(km), walk, far: walk ? `${kmText(km)} (${walk} on foot)` : kmText(km), vehicle, vehicles };
}

function handover(route: Route, e: Estimate, t: Today): Handover {
  const lines = [...new Set([...(t.before?.lines ?? []), ...(t.after?.lines ?? [])])];
  return {
    a: stationName(t.ride.from),
    b: stationName(t.ride.to),
    aId: t.ride.from,
    bId: t.ride.to,
    // Today's ride runs between running Line 6 stations: DMTCL's own figures.
    time: approx(duration(t.ride.shownMinutes), t.ride.published),
    fare: approx(taka(t.ride.fare), t.ride.published),
    covered: kmText(tenth(t.ride.km)),
    share: Math.round((t.ride.km / e.km) * 100),
    origin: stationName(route.legs[0].from),
    dest: stationName(route.legs[route.legs.length - 1].to),
    before: gap(t.before),
    after: gap(t.after),
    waits: waitsFor(lines),
  };
}

/** The three stations where a trip can hand over between Line 6 and the road today, with a little local colour. */
const PLACES: Record<string, readonly string[]> = {
  'karwan-bazar': ["home to one of Dhaka's busiest wholesale markets", 'where the kitchen market trades through the night'],
  'mirpur-10': ["home to one of Mirpur's busiest roundabouts"],
  motijheel: ["Dhaka's business district", "the city's commercial heart"],
};

/** ", Dhaka's business district" after a station name, or nothing. `closed` adds the comma that ends it mid-sentence. */
const place = (id: string, closed = false): string => (PLACES[id] ? `, ${pick(PLACES[id])}${closed ? ',' : ''}` : '');

type Say2 = (h: Handover) => string;

/** Line 6 first, then the road. */
const START_TITLES = ['You can start today', 'Head start: Line 6 runs now', 'The first stretch is open today'];
const START: Say2[] = [
  (h) =>
    `Line 6 already runs from ${h.a} to ${h.b}: ${h.time} and ${h.fare}. The last ${h.after!.far}, on to ${h.dest}, is road territory until ${h.after!.names} ${h.after!.verb}.`,
  (h) => `Ride Line 6 from ${h.a} to ${h.b} today (${h.time}, ${h.fare}), then hand over to ${h.after!.vehicle} for the last ${h.after!.far} to ${h.dest}.`,
  (h) => `${h.share}% of this trip runs today: Line 6 from ${h.a} to ${h.b}, ${h.time} for ${h.fare}. The other ${h.after!.km} waits for ${h.after!.names}.`,
  (h) => `Today, Line 6 takes you as far as ${h.b}${place(h.bId)}: ${h.time}, ${h.fare}. After that, the road takes over until ${h.after!.names} ${h.after!.verb}.`,
];

/** The road first, then Line 6. */
const END_TITLES = ['You can finish on Line 6 today', 'The last stretch runs today', 'Line 6 can take it from there, today'];
const END: Say2[] = [
  (h) => `Get to ${h.a} by road for now, about ${h.before!.far} from ${h.origin}, and Line 6 does the rest today: ${h.time} and ${h.fare} to ${h.b}.`,
  (h) =>
    `Until ${h.before!.names} ${h.before!.verb}, the first ${h.before!.far} is up to ${h.before!.vehicles}. From ${h.a}, Line 6 already runs to ${h.b}: ${h.time}, ${h.fare}.`,
  (h) => `Line 6 already covers the last ${h.covered} of this trip, ${h.a} to ${h.b}, in ${h.time} for ${h.fare}. Getting to ${h.a}${place(h.aId, true)} is the road's job for now.`,
];

/** The road, Line 6, then the road again. */
const MIDDLE_TITLES = ['The middle runs today', 'Line 6 covers the middle today'];
const MIDDLE: Say2[] = [
  (h) =>
    `Only the middle runs today: Line 6 from ${h.a} to ${h.b}, ${h.time} and ${h.fare}. Getting to ${h.a} and on from ${h.b} is up to the road until ${h.waits.names} ${h.waits.verb}.`,
  (h) =>
    `Line 6 can already do its bit, ${h.a} to ${h.b} (${h.time}, ${h.fare}). The first ${h.before!.km} and the last ${h.after!.km} are road territory for now.`,
  (h) => `${h.share}% of this trip runs today, in the middle: Line 6 from ${h.a} to ${h.b}, ${h.time} for ${h.fare}. The bits either side wait for ${h.waits.names}.`,
];

/** Line 6 alone, to or from Kamlapur: today it stops 1.2 km short, at Motijheel. */
const KAMLAPUR_TITLES = ["Can't wait for Kamlapur?", 'Until Kamlapur opens'];
const TO_KAMLAPUR: Say2[] = [
  (h) => `Line 6 already gets you as far as Motijheel: ${h.time} and ${h.fare}. Kamlapur is ${h.after!.km} on, ${h.after!.walk} on foot.`,
  (h) => `Ride to Motijheel today (${h.time}, ${h.fare}) and cover the last ${h.after!.km} on foot (${h.after!.walk}). Or let a rickshaw do it.`,
];
const FROM_KAMLAPUR: Say2[] = [
  (h) => `Start at Motijheel instead, ${h.before!.km} away, ${h.before!.walk} on foot. Line 6 runs from there today: ${h.time} and ${h.fare} to ${h.b}.`,
  (h) => `Walk or rickshaw the ${h.before!.far} to Motijheel, and Line 6 takes over today: ${h.time}, ${h.fare} to ${h.b}.`,
];

/** Motijheel to Kamlapur, or back: no train until the station opens, but hardly a trip. */
const KAMLAPUR_HOP: Array<(km: string, walk: string, saved: string) => string> = [
  (km, walk) => `Until it opens, Motijheel and Kamlapur are ${km} apart: ${walk} on foot, or one short rickshaw ride.`,
  (_km, walk, saved) => `Until then, it's ${walk} on foot. Once the station opens, the metro will save you all of ${saved}.`,
];

/** The note on what of a trip can be ridden today, or null when it all can (or none of it). */
function todayNote(route: Route): Note | null {
  const e = estimate(route);
  const t = today(route);
  if (!t) {
    const hop = route.legs.length === 1 && route.legs[0].hops.every((h) => h.feature === '6-extension');
    if (!hop) return null;
    const km = tenth(e.km);
    const walk = rough(walkingMinutes(km));
    return {
      title: pick(KAMLAPUR_TITLES),
      text: pick(KAMLAPUR_HOP)(kmText(km), approx(duration(walk)), approx(duration(walk - e.minutes))),
    };
  }
  const h = handover(route, e, t);
  if (route.legs.length === 1) {
    // The only road stretch is Motijheel to Kamlapur.
    return { title: pick(KAMLAPUR_TITLES), text: pick(h.after ? TO_KAMLAPUR : FROM_KAMLAPUR)(h) };
  }
  if (h.before && h.after) return { title: pick(MIDDLE_TITLES), text: pick(MIDDLE)(h) };
  if (h.after) return { title: pick(START_TITLES), text: pick(START)(h) };
  return { title: pick(END_TITLES), text: pick(END)(h) };
}

/* --------------------------------------------------------- journey quips */

/** What a quip can draw on. */
interface Trip {
  route: Route;
  e: Estimate;
  ready: Readiness;
}

type Say = (t: Trip) => string;

interface Theme {
  name: string;
  when: (t: Trip) => boolean;
  lines: readonly Say[];
}

const time = (t: Trip) => approx(duration(t.e.minutes), t.e.published);
const fare = (t: Trip) => approx(taka(t.e.fare), t.e.published);
/** A sum of money worked out from the fare: exact when the fare is. */
const money = (t: Trip, n: number) => approx(taka(n), t.e.published);
/** Changes only happen between lines, so their minutes are always estimates. */
const mins = (n: number) => approx(duration(n));
const tickets = (t: Trip) => t.e.legs.length;
const changeShare = (t: Trip) => (t.e.minutes ? t.e.changeMinutes / t.e.minutes : 0);
/** The distance as shown (one decimal), so a reader redoing the sums gets the same answers. */
const km = (t: Trip) => Math.round(t.e.km * 10) / 10;
/** Walking time at 5 km/h, roughened. What the metro saves is worked out against this rough figure, so the two agree. */
const onFoot = (t: Trip) => rough(walkingMinutes(km(t)));
const byRoad = (t: Trip, kmh: number) => rough((km(t) / kmh) * 60);
const speed = (t: Trip) => Math.round(km(t) / (t.e.minutes / 60));
const future = (t: Trip) => (t.ready.kind === 'future' ? t.ready : null);

const THEMES: Theme[] = [
  {
    name: 'time',
    when: (t) => t.e.minutes <= 10,
    lines: [
      (t) => `${time(t)}. Blink and you'll miss your stop.`,
      () => 'Over before your cha goes cold.',
      () => 'Barely time to find a seat, let alone warm it.',
      () => 'Quicker than settling a fare with a rickshaw-wallah.',
    ],
  },
  {
    name: 'time',
    when: (t) => t.e.minutes > 10 && t.e.minutes <= 25,
    lines: [
      () => "Just enough time to answer every 'where are you?' text.",
      () => 'About three songs and a podcast intro.',
      () => 'Long enough to people-watch. Too short to nap.',
      () => 'Some Dhaka traffic signals take longer to turn green.',
    ],
  },
  {
    name: 'time',
    when: (t) => t.e.minutes > 25 && t.e.minutes <= 45,
    lines: [
      () => 'Long enough for a power nap. Set an alarm.',
      () => 'About one TV drama episode, minus the ad breaks.',
      () => 'Enough to read the paper front to back. Start with this story.',
      (t) => `${time(t)}: bring a book. A short one.`,
    ],
  },
  {
    name: 'time',
    when: (t) => t.e.minutes > 45 && t.e.minutes <= 75,
    lines: [
      () => 'Long enough to finish a chapter and start a friendship.',
      () => 'Charge your phone before you board.',
      () => 'Long, yes. Now picture the same trip by road at 6pm.',
      (t) => `${time(t)} of air-conditioned calm. There are worse ways to spend it.`,
    ],
  },
  {
    name: 'time',
    when: (t) => t.e.minutes > 75,
    lines: [
      () => 'An expedition. Pack tiffin.',
      () => 'Clear your afternoon, or at least queue up a very long playlist.',
      () => 'Long enough to watch a film on your phone. Headphones, please.',
      (t) => `${time(t)}, clean across the city. This is what a network is for.`,
    ],
  },
  {
    name: 'fare',
    when: (t) => t.e.fare === 20,
    lines: [
      () => 'The minimum fare. Only your own two feet come cheaper.',
      () => "Tk 20 is the floor. Metro fares don't go any lower.",
      () => 'The cheapest ticket in the system. Nicely done.',
    ],
  },
  {
    name: 'fare',
    when: (t) => t.e.fare > 20 && t.e.fare <= 50,
    lines: [
      () => 'Well under what a CNG driver will quote you.',
      () => 'Pocket change for skipping the jam.',
      () => 'Cheap enough to do twice. You probably will: there and back.',
      (t) => `${fare(t)}, and not a single horn included.`,
    ],
  },
  {
    name: 'fare',
    when: (t) => t.e.fare > 50 && t.e.fare <= 100,
    lines: [
      () => 'A fair price for not sitting in traffic.',
      (t) => `${fare(t)} to skip the jam entirely.`,
      () => 'Worth every taka if your evening matters to you.',
      () => "No haggling, and no meter that's 'broken today'.",
    ],
  },
  {
    name: 'fare',
    when: (t) => t.e.fare > 100 && t.e.fare <= 160,
    lines: [
      () => 'Not pocket change. Then again, neither is two hours in traffic.',
      () => 'A splurge by metro standards. The road would bill you in hours instead.',
      () => 'The price of crossing a big slice of the city without meeting a single jam.',
    ],
  },
  {
    name: 'fare',
    when: (t) => t.e.fare > 160,
    lines: [
      () => 'Top-tier fare for a top-tier distance.',
      (t) => `${fare(t)}: priced like a long trip, because it is one.`,
      () => 'The long-haul special. Your wallet will feel it; your back will thank you.',
    ],
  },
  {
    name: 'chart-top',
    when: (t) => t.e.published && t.e.fare === 100,
    lines: [
      () => "Tk 100 is the top of Line 6's fare chart. You rode the whole line.",
      () => 'The priciest ticket on Line 6, for its longest ride. Fair trade.',
    ],
  },
  {
    name: 'tickets',
    when: (t) => tickets(t) > 1,
    lines: [
      (t) => `${capital(word(tickets(t)))} tickets, one per line: tap out, tap in, repeat.`,
      (t) => `That's ${word(tickets(t))} tickets. Keep your MRT Pass topped up.`,
      (t) => `${capital(word(tickets(t)))} lines, ${word(tickets(t))} fares, one very well-travelled rider.`,
    ],
  },
  {
    name: 'commute',
    when: () => true,
    lines: [
      (t) =>
        `Commute this both ways every workday and it's ${money(t, t.e.fare * 2 * WORKDAYS)} a month, or ${money(t, t.e.passFare * 2 * WORKDAYS)} with an MRT Pass.`,
      (t) =>
        `Doing this there and back daily? Budget ${money(t, t.e.fare * 2 * WORKDAYS)} a month. An MRT Pass trims ${money(t, (t.e.fare - t.e.passFare) * 2 * WORKDAYS)} off that.`,
    ],
  },
  {
    name: 'road',
    when: (t) => t.e.km >= 3,
    lines: [
      (t) =>
        `${t.e.changes.length ? 'Stops and changes' : 'Stops'} included, you average ${speed(t)}${NB}km/h. The World Bank found Dhaka's road traffic averaging ${ROAD_KMH}${NB}km/h.`,
      (t) =>
        `At the ${ROAD_KMH}${NB}km/h the World Bank measured on Dhaka's roads, these ${kmText(t.e.km)} would take ${mins(byRoad(t, ROAD_KMH))}.`,
      (t) =>
        `The World Bank warned Dhaka's traffic could slow to ${ROAD_KMH_2035}${NB}km/h by 2035. At that crawl, this trip takes ${mins(byRoad(t, ROAD_KMH_2035))}.`,
    ],
  },
  {
    name: 'walk',
    when: (t) => t.e.km >= 3,
    lines: [
      (t) =>
        onFoot(t) > t.e.minutes
          ? `On foot, ${kmText(t.e.km)} is ${mins(onFoot(t))}. The metro hands you back ${mins(onFoot(t) - t.e.minutes)}.`
          : `On foot, ${kmText(t.e.km)} is ${mins(onFoot(t))}. With these changes, the metro is no quicker. Awkward.`,
      (t) => `Walking this would take ${mins(onFoot(t))}, and a change of shirt.`,
      (t) => `${mins(onFoot(t))} on foot, or ${time(t)} by metro. Tough call.`,
    ],
  },
  {
    name: 'walk',
    when: (t) => t.e.km < 3,
    lines: [
      (t) => `It's only ${kmText(t.e.km)}: ${mins(onFoot(t))} on foot, if the heat allows.`,
      (t) => `Honestly? ${kmText(t.e.km)} is walkable in ${mins(onFoot(t))}. But it's Dhaka, and it's hot.`,
    ],
  },
  {
    name: 'change',
    when: (t) => t.e.changes.length > 0 && changeShare(t) >= 0.45,
    lines: [
      (t) =>
        t.e.changes.length === 1
          ? `Fun fact: ${Math.round(changeShare(t) * 100)}% of this trip is the change at ${stationName(t.e.changes[0].station)}. The trains are quick; the stairs are not.`
          : `Fun fact: ${Math.round(changeShare(t) * 100)}% of this trip is spent changing trains. The trains are quick; the corridors are long.`,
      (t) => `You'll spend ${mins(t.e.changeMinutes)} changing and ${mins(t.e.rideMinutes)} riding. The trains are the fast part.`,
    ],
  },
  {
    name: 'change',
    when: (t) => t.e.changes.length === 1 && changeShare(t) < 0.45,
    lines: [
      (t) =>
        `${mins(t.e.changeMinutes)} of that is the change at ${stationName(t.e.changes[0].station)}: the walk between platforms and the wait for the next train.`,
      (t) => `One change at ${stationName(t.e.changes[0].station)}. Allow ${mins(t.e.changeMinutes)}, and skip the selfie.`,
    ],
  },
  {
    name: 'change',
    when: (t) => t.e.changes.length > 1 && changeShare(t) < 0.45,
    lines: [
      (t) => `${capital(word(t.e.changes.length))} changes. Consider it cardio.`,
      (t) => `${capital(word(t.e.changes.length))} changes take ${mins(t.e.changeMinutes)} of your ${time(t)}.`,
    ],
  },
  {
    name: 'future',
    when: (t) => future(t) !== null,
    lines: [
      (t) => `Priced at ${thisYear()} rates. By ${future(t)!.year}, inflation will have opinions.`,
      (t) => `That's in ${thisYear()} taka. The ${future(t)!.year} fare is anybody's guess.`,
      () => 'Fares for lines still being built: treat them as a well-educated guess.',
    ],
  },
  {
    name: 'future',
    when: (t) => t.ready.kind === 'planning',
    lines: [
      () => 'We priced a line that is still on paper. Prices may vary by decade.',
      () => "An estimate for a line with no deadline. Frame it; it may become a collector's item.",
      () => 'The fare has a number. The opening date does not.',
    ],
  },
  {
    name: 'future',
    when: (t) => t.ready.kind === 'kamlapur',
    lines: [
      () => `Kamlapur is due to open by ${KAMLAPUR_OPENING}. Its fares aren't published yet, so this is our estimate.`,
      () => "One more station, one more fare to publish. Until then, ours is the best guess you'll get.",
    ],
  },
];

/** Themes of the last few quips, so the next one talks about something else. */
const recentThemes: string[] = [];

function journeyQuip(trip: Trip): string {
  const fitting = THEMES.filter((theme) => theme.when(trip));
  const fresh = fitting.filter((theme) => !recentThemes.includes(theme.name));
  const pool = fresh.length ? fresh : fitting;
  const theme = pool[Math.floor(Math.random() * pool.length)];
  recentThemes.unshift(theme.name);
  recentThemes.length = Math.min(recentThemes.length, 3);
  return pick(theme.lines)(trip);
}

/** Where the numbers come from: the published chart, or our estimate (never how it is worked out). */
function basis(route: Route, e: Estimate): string {
  const wait = ' Excludes the wait for your first train.';
  if (e.published) return `DMTCL's Line 6 fare chart and running times.${wait}`;
  if (route.legs.every((l) => l.line === '6')) return `Kamlapur's fares are not published yet, so these are estimates.${wait}`;
  if (!e.changes.length) return `Estimated from Line 6's published fares and running times.${wait}`;
  return `Estimated from Line 6's published fares and running times, one ticket per line. Each change allows for a platform walk and the wait for the next train.${wait}`;
}

function journeyFigures(route: Route): Figures {
  const e = estimate(route);
  const several = e.legs.length > 1;
  const steps: Step[] = several
    ? e.legs.flatMap((leg, i) => {
        const ride: Step = {
          line: leg.line,
          text: `${stationName(leg.from)} to ${stationName(leg.to)}`,
          detail: `${stops(leg.stops)} · ${kmText(leg.km)}`,
          time: approx(duration(leg.shownMinutes), leg.published),
          fare: approx(taka(leg.fare), leg.published),
        };
        const c = e.changes[i];
        if (!c) return [ride];
        const change: Step = {
          line: null,
          text: `Change at ${stationName(c.station)}`,
          detail: `${approx(duration(c.walk))} walk, ${approx(duration(c.wait))} wait`,
          time: approx(duration(c.shownMinutes)),
          fare: '',
        };
        return [ride, change];
      })
    : [];

  const riding = approx(duration(e.rideMinutes), e.legs.every((l) => l.published));
  return {
    time: {
      value: approx(duration(e.minutes), e.published),
      note: several ? `${riding} riding, ${approx(duration(e.changeMinutes))} changing` : 'Platform to platform',
    },
    fare: {
      value: approx(taka(e.fare), e.published),
      note: `${several ? `${capital(word(e.legs.length))} tickets · ` : ''}${approx(taka(e.passFare), e.published)} with an MRT${NB}Pass`,
    },
    quip: journeyQuip({ route, e, ready: readiness(route) }),
    basis: basis(route, e),
    steps,
    meta: `${changes(route.changes.length)} · ${stops(route.stops)} · ${kmText(e.km)}`,
  };
}

/* ----------------------------------------------------------- suggestion */

export interface Suggestion {
  title: string;
  text: string;
}

const SOONER_TITLES = ['Rather not wait?', 'Want to ride sooner?', 'Prefer a line with a date?'];

/** Offered under a result that needs a line still being planned: a route that can be ridden sooner. */
export function datedSuggestion(planned: Route, alternative: Route): Suggestion {
  const skipped = readiness(planned);
  const ready = readiness(alternative);
  const skips = skipped.kind === 'planning' ? `skips ${listOf(skipped.lines.map(lineName))}` : 'has a date';
  let when = 'you could ride it sooner';
  if (ready.kind === 'running') when = 'you can ride it today';
  else if (ready.kind === 'kamlapur') when = `you could ride it by ${KAMLAPUR_OPENING}`;
  else if (ready.kind === 'future') when = `you could ride it by ${keep(`${MONTHS[ready.month - 1]} ${ready.year}`)}`;

  const a = estimate(alternative);
  const p = estimate(planned);
  const dt = a.minutes - p.minutes;
  const df = a.fare - p.fare;
  // The planned route is always an estimate, so the gap is one too.
  const takes = dt > 0 ? `takes ${approx(duration(dt))} longer` : dt < 0 ? `is ${approx(duration(-dt))} quicker` : 'takes the same time';
  const costs = df > 0 ? `costs ${approx(taka(df))} more` : df < 0 ? `costs ${approx(taka(-df))} less` : 'costs the same';
  // The catch, the bonus, or a bit of both.
  const lead = dt >= 0 && df >= 0 && dt + df > 0 ? 'The catch: it ' : dt <= 0 && df <= 0 && dt + df < 0 ? 'Bonus: it ' : 'It ';
  return {
    title: pick(SOONER_TITLES),
    text: `This route ${skips}, so ${when}. ${lead}${takes} and ${costs}.`,
  };
}

/* ----------------------------------------------------------- dead ends */

const WALK_QUIPS = ['No ticket, no transfer, no deadline.', 'Your legs are fully operational.', 'Cheapest trip in Dhaka.', 'Zero stops. Zero changes. Zero taka.'];

export function walkResult(station: string): Result {
  return {
    kicker: `${stationName(station)} to ${stationName(station)}`,
    title: 'You can just walk.',
    text: `You're already at ${stationName(station)}. ${pick(WALK_QUIPS)}`,
    figures: {
      time: { value: `0${NB}min`, note: "You're already there" },
      fare: { value: `Tk${NB}0`, note: 'The minimum fare is Tk\u00a020. Keep it.' },
      quip: '',
      basis: '',
      steps: [],
      meta: '',
    },
  };
}

export function noRouteResult(from: string, to: string): Result {
  return {
    kicker: `${stationName(from)} to ${stationName(to)}`,
    title: 'No metro route exists.',
    text: 'Kindly wait for another MRT line.',
  };
}
