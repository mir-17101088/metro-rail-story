import { KAMLAPUR_OPENING, LINES, type LineId } from '../data/lines';
import { stationById } from '../data/network';
import { readiness, type Route } from './routes';

/**
 * Every line of text the route game shows. Editors can change the wording
 * here without touching the game logic. Where a list offers several lines,
 * one is picked at random so replays do not read the same every time.
 *
 * Text wrapped in {{double braces}} is kept on one line when shown (so
 * "MRT Line-5 (South)" never breaks at its hyphen); see `toHtml` and `toPlain`.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

export const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

export const stationName = (id: string): string => stationById.get(id)?.properties.name ?? id;

/** "Line 5 North", as in the network explorer. */
export const lineName = (line: LineId): string => LINES[line].name;

const keep = (s: string) => `{{${s}}}`;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Escaped HTML, with {{kept}} phrases unbreakable. */
export const toHtml = (s: string): string => esc(s).replace(/\{\{(.+?)\}\}/g, '<span class="nobr">$1</span>');

/** For screen reader announcements. */
export const toPlain = (s: string): string => s.replace(/\{\{|\}\}/g, '');

/** "MRT Line-5 (North)", as in the project names. */
export function projectName(line: LineId): string {
  if (line === '5N') return keep('MRT Line-5 (North)');
  if (line === '5S') return keep('MRT Line-5 (South)');
  return keep(`MRT Line-${line}`);
}

/** Non-breaking, so "10 stops" or "Dec 2035" never splits across lines. */
const plural = (n: number, one: string, many = `${one}s`) => `${n}\u00a0${n === 1 ? one : many}`;

export const stops = (n: number): string => plural(n, 'stop');

export const changes = (n: number): string => (n ? plural(n, 'change') : 'No\u00a0changes');

const listOf = (items: string[]): string =>
  items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export const listNames = (ids: string[]): string => listOf(ids.map(stationName));

/* ------------------------------------------------------------- prompts */

export const HINT = {
  idle: 'Pick two stations. Or tap them on the map.',
  idleNoMap: 'Pick two stations to plan a trip.',
  fromOnly: ['Good start. Now, where to?', 'Nice pick. Where are you headed?', 'Starting point locked in. Where to?'],
  toOnly: ['Great destination. Where are you starting from?', 'Lovely spot. And where are you coming from?'],
} as const;

/* ------------------------------------------------------------- options */

export function optionsHeading(count: number): { title: string; text: string } {
  const words = ['', 'One', 'Two', 'Three', 'Four'];
  return {
    title: `${words[count] ?? count} ways to get there`,
    text: 'Fewest changes first. Pick your ride.',
  };
}

export function routeName(route: Route): string {
  return route.changes.length ? `Via ${listNames(route.changes)}` : `Direct on ${lineName(route.legs[0].line)}`;
}

export function routeMeta(route: Route): string {
  return `${changes(route.changes.length)} · ${stops(route.stops)} · ${readyShort(route)}`;
}

function readyShort(route: Route): string {
  const ready = readiness(route);
  if (ready.kind === 'running') return 'Running\u00a0now';
  if (ready.kind === 'kamlapur') return 'Early\u00a02027';
  if (ready.kind === 'planning') return 'No\u00a0date\u00a0yet';
  return `${MONTHS_SHORT[ready.month - 1]}\u00a0${ready.year}`;
}

/* ------------------------------------------------------------- captions */

export interface Caption {
  lines: LineId[];
  title: string;
  text: string;
}

export function boardCaption(route: Route, index: number): Caption {
  const leg = route.legs[index];
  const next = index < route.legs.length - 1 ? `to change at ${stationName(leg.to)}` : `to ${stationName(leg.to)}`;
  // A line with no deadline yet only exists on paper.
  const line = LINES[leg.line].completion === 'planning' ? `${lineName(leg.line)} (still on paper)` : lineName(leg.line);
  return {
    lines: [leg.line],
    title: index === 0 ? `All aboard at ${stationName(leg.from)}` : `Now riding ${lineName(leg.line)}`,
    text: `${line} · ${stops(leg.hops.length)} ${next}`,
  };
}

const CHANGE_QUIPS = ['Mind the gap.', 'Quick platform swap.', 'Stretch your legs.', 'Follow the signs.'];

export function changeCaption(route: Route, index: number): Caption {
  const from = route.legs[index];
  const to = route.legs[index + 1];
  return {
    lines: [from.line, to.line],
    title: `Change at ${stationName(from.to)}`,
    text: `${pick(CHANGE_QUIPS)} Switch from ${lineName(from.line)} to ${lineName(to.line)}.`,
  };
}

/* -------------------------------------------------------------- results */

export interface Result {
  kicker: string;
  title: string;
  text: string;
}

const RUNNING_QUIPS = [
  "It's already running. No deadline required.",
  'The trains are running today. Mind the rush hour.',
  'No waiting on this one. Just tap in.',
];

const DEADLINE_QUIPS = ['Deadlines permitting.', 'Mark your calendar. In pencil.', 'Pack some patience.'];

const PLANNING_QUIPS = ["Don't hold your breath.", 'Keep your rickshaw fare handy.', 'Consider this a sneak preview.'];

/**
 * The result card for a finished ride. `alternative` is the best route that
 * avoids lines still being planned, when the ride itself needed one.
 */
export function routeResult(route: Route, alternative: Route | null = null): Result {
  const from = stationName(route.legs[0].from);
  const to = stationName(route.legs[route.legs.length - 1].to);
  const ready = readiness(route);
  const kicker = `Arrived at ${to}`;

  if (ready.kind === 'planning') {
    const lines = listOf(ready.lines.map(projectName));
    const one = ready.lines.length === 1;
    const noOther = alternative ? '' : ' There is no other way to make this trip yet, either.';
    return {
      kicker: `${kicker}, on paper`,
      title: `You'll reach ${to} from ${from} once ${lines} ${one ? 'leaves' : 'leave'} the drawing board.`,
      text: `${one ? `${lines} is` : 'Both lines are'} still in the planning stage, with no completion deadline yet.${noOther} ${pick(PLANNING_QUIPS)}`,
    };
  }

  if (ready.kind === 'running') {
    return { kicker, title: `You can just take ${projectName('6')} to reach ${to} from ${from}.`, text: pick(RUNNING_QUIPS) };
  }

  if (ready.kind === 'kamlapur') {
    return {
      kicker,
      title: `You can take ${projectName('6')} to reach ${to} from ${from} by ${KAMLAPUR_OPENING}.`,
      text: "That's when Kamlapur station is due to open. It is 77.2% built.",
    };
  }

  const date = `${MONTHS[ready.month - 1]} ${ready.year}`;
  const years = ready.year - new Date().getFullYear();
  const when = years > 1 ? `, ${years} years from now` : years === 1 ? ', a year from now' : '';
  const line = projectName(ready.line);
  const reason =
    ready.lines.length > 1
      ? `That's when ${line}, the last line on your trip, is due to be finished${when}.`
      : `That's the completion deadline for ${line}${when}.`;
  return {
    kicker,
    title: `You'll be able to ride the metro from ${from} to ${to} by ${keep(date)}.`,
    text: `${reason} ${pick(DEADLINE_QUIPS)}`,
  };
}

export interface Suggestion {
  title: string;
  text: string;
}

/** Offered under a result that needs a line still being planned: a route that can be ridden sooner. */
export function datedSuggestion(planned: Route, alternative: Route): Suggestion {
  const skipped = readiness(planned);
  const ready = readiness(alternative);
  const skips = skipped.kind === 'planning' ? `skips ${listOf(skipped.lines.map(lineName))}` : 'has a date';
  let when = 'you could ride it sooner';
  if (ready.kind === 'running') when = 'you can ride it today';
  else if (ready.kind === 'kamlapur') when = `you could ride it by ${KAMLAPUR_OPENING}`;
  else if (ready.kind === 'future') when = `you could ride it by ${keep(`${MONTHS[ready.month - 1]} ${ready.year}`)}`;
  return {
    title: 'Rather not wait?',
    text: `This route ${skips}, so ${when}.`,
  };
}

const WALK_QUIPS = ['No ticket, no transfer, no deadline.', 'Your legs are fully operational.', 'Cheapest trip in Dhaka.'];

export function walkResult(station: string): Result {
  return {
    kicker: `${stationName(station)} to ${stationName(station)}`,
    title: 'You can just walk.',
    text: `You're already at ${stationName(station)}. ${pick(WALK_QUIPS)}`,
  };
}

export function noRouteResult(from: string, to: string): Result {
  return {
    kicker: `${stationName(from)} to ${stationName(to)}`,
    title: 'No route exists.',
    text: 'Kindly wait for another MRT line.',
  };
}
