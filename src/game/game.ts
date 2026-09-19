// Travels with this chunk rather than the entry stylesheet: the section is
// hidden until the code below runs, so its styles are never needed sooner.
import '../styles/game.css';

import type { PaddingOptions } from 'mapbox-gl/esm';
import { LINES, type LineId } from '../data/lines';
import { prefersReducedMotion } from '../lib/motion';
import { mapUnsupportedReason } from '../map/support';
import type { MapToken } from '../map/token';
import * as copy from './copy';
import type { GameMap } from './game-map';
import { StationPicker, type CommitSource } from './picker';
import { findDatedRoute, findRoutes, readiness, type Route } from './routes';

/**
 * "Pick a station": the route game after the timeline.
 *
 * The reader picks a start and a destination (in the fields, or by tapping
 * stations on the map). Every sensible route is worked out at once:
 * - the same station twice: "You can just walk";
 * - no connection: "No route exists";
 * - exactly one route: the ride plays straight away;
 * - several: they are listed, fewest changes first, and the chosen one plays.
 *
 * The page logic here works without the map (no WebGL 2, no token, or reduced
 * motion): the reader then gets the result card without the ride. The map
 * itself (mapbox, the train) is a separate chunk, loaded as the section nears
 * the screen.
 */

type Phase = 'idle' | 'half' | 'walk' | 'none' | 'choose' | 'play' | 'done';

interface Options {
  /** The page's shared Mapbox token request. */
  token: () => Promise<MapToken>;
}

const WIDE = window.matchMedia('(min-width: 1024px)');
const COARSE = window.matchMedia('(pointer: coarse)');
/** How long a ride waits for a map that is still loading before showing the result without it. */
const MAP_PATIENCE_MS = 6000;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const badge = (line: LineId) =>
  `<span class="badge badge--sm" style="--c: var(--line-${line.toLowerCase()})">${line}</span>`;

/**
 * A route as a button: its line badges, where it changes, when it can be
 * ridden, and what it takes in time and money. `tags` marks the fastest or
 * cheapest of several.
 */
function routeButton(route: Route, attributes: string, tags: string[] = []): string {
  const lines = route.legs.map((leg) => leg.line);
  const spoken = lines.map((l) => LINES[l].name).join(', then ');
  const figures = copy.routeFigures(route);
  const labels = tags
    .map((tag) => `<span class="visually-hidden">, </span><span class="route-btn__tag">${esc(tag)}</span>`)
    .join('');
  return `<button class="route-btn" type="button" ${attributes}>
    <span class="route-btn__lines" aria-hidden="true">${lines.map(badge).join('<span class="route-btn__to"></span>')}</span>
    <span class="route-btn__text">
      <span class="route-btn__name">${esc(copy.routeName(route))}${labels}</span>
      <span class="route-btn__meta">${esc(copy.routeMeta(route))}<span class="visually-hidden">. ${esc(spoken)}.</span></span>
    </span>
    <span class="route-btn__figures">
      <span class="route-btn__time"><span class="visually-hidden">. </span>${copy.toHtml(figures.time)}</span>
      <span class="route-btn__fare"><span class="visually-hidden">, </span>${copy.toHtml(figures.fare)}</span>
    </span>
    <span class="route-btn__go" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" /></svg></span>
  </button>`;
}

const CLOCK_ICON =
  '<svg class="game-caption__clock-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.25" /><path d="M8 4.75V8l2.25 1.5" /></svg>';

const wait = (ms: number) => new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms));

/** Calls back once the page has not scrolled for a moment. */
function whenStill(callback: () => void, quietMs = 250): void {
  let timer = 0;
  const done = () => {
    window.removeEventListener('scroll', arm);
    callback();
  };
  const arm = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(done, quietMs);
  };
  window.addEventListener('scroll', arm, { passive: true });
  arm();
}

/** The fixed masthead's height: anything scrolled to has to land below it. */
const mastheadHeight = (): number => document.querySelector('.masthead')?.getBoundingClientRect().height ?? 68;

/** How long the result card takes to fade out when closed (matches result-out in game.css). */
const CLOSE_MS = 160;

/** A result card as one announcement for screen readers. */
function resultText(result: copy.Result, suggestion: copy.Suggestion | null = null): string {
  const f = result.figures;
  const numbers = f
    ? `${copy.STAT_LABELS.time}: ${f.time.value}, ${f.time.note}. ${copy.STAT_LABELS.fare}: ${f.fare.value}, ${f.fare.note}. ${f.quip}`
    : '';
  const now = result.today ? `${result.today.title}. ${result.today.text}` : '';
  return copy.toPlain([result.title, result.text, numbers, now, suggestion?.title, suggestion?.text].filter(Boolean).join(' '));
}

export function initGame(root: HTMLElement, options: Options): Game {
  return new Game(root, options);
}

export class Game {
  private readonly panel: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly mapContainer: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly optionsList: HTMLElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly caption: HTMLElement;
  private readonly result: HTMLElement;
  private readonly fallback: HTMLElement;
  private readonly live: HTMLElement;
  private readonly fromPicker: StationPicker;
  private readonly toPicker: StationPicker;

  private from: string | null = null;
  private to: string | null = null;
  private routes: Route[] = [];
  private active: Route | null = null;
  /** After a ride that needs a line still being planned: a route with a date, offered on the result card. */
  private alternative: Route | null = null;
  private phase: Phase = 'idle';
  private hintText = '';
  /** Heading over the route options, written once per pair of stations. */
  private heading: copy.Heading | null = null;
  /** The caption whose trip clock is on screen, and the minute it shows. */
  private clockCaption: copy.Caption | null = null;
  private clockMinute = -1;
  private clockElement: HTMLElement | null = null;
  private closeTimer = 0;
  /** Increments on every change of trip; async work for an older trip checks it and stops. */
  private ticket = 0;
  private skipping = false;

  private map: GameMap | null = null;
  private mapLoad: Promise<GameMap | null> | null = null;
  private mapFailed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: Options,
  ) {
    this.panel = root.querySelector('[data-game-panel]')!;
    this.viewport = root.querySelector('[data-game-viewport]')!;
    this.mapContainer = root.querySelector('[data-game-map]')!;
    this.hint = root.querySelector('[data-game-hint]')!;
    this.optionsList = root.querySelector('[data-game-options]')!;
    this.resetButton = root.querySelector('[data-game-reset]')!;
    this.caption = root.querySelector('[data-game-caption]')!;
    this.result = root.querySelector('[data-game-result]')!;
    this.fallback = root.querySelector('[data-game-fallback]')!;
    this.live = root.querySelector('[data-game-live]')!;
    this.fromPicker = new StationPicker(root.querySelector('[data-picker="from"]')!);
    this.toPicker = new StationPicker(root.querySelector('[data-picker="to"]')!);

    root.hidden = false;
    this.caption.inert = true;
    if (import.meta.env.DEV) Object.assign(window, { __game: this });
    this.bind();
    this.refresh();
    this.loadMapWhenNear();
  }

  /* -------------------------------------------------------------- events */

  private bind(): void {
    this.fromPicker.onCommit((id, source) => this.commit('from', id, source));
    this.toPicker.onCommit((id, source) => this.commit('to', id, source));

    this.root.querySelector('form')?.addEventListener('submit', (event) => event.preventDefault());
    this.resetButton.addEventListener('click', () => this.reset());

    this.result.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-game-close]')) this.closeResult();
      else if (target.closest('[data-game-again]')) this.planAnother();
      else if (target.closest('[data-game-alt]') && this.alternative) void this.start(this.alternative);
    });
    this.result.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closeResult();
    });
    this.caption.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-game-skip]')) this.skip();
    });

    this.optionsList.addEventListener('click', (event) => {
      const route = this.routeFrom(event.target);
      if (route) void this.start(route);
    });
    // Hovering or focusing an option previews it on the map.
    this.optionsList.addEventListener('pointerover', (event) => {
      if (event.pointerType === 'mouse') this.preview(this.routeFrom(event.target));
    });
    this.optionsList.addEventListener('pointerleave', () => this.preview(null));
    this.optionsList.addEventListener('focusin', (event) => this.preview(this.routeFrom(event.target)));
    this.optionsList.addEventListener('focusout', () => this.preview(null));

    // A window crossing the breakpoint moves a waiting choice between the map and the panel.
    WIDE.addEventListener('change', () => this.render());
  }

  private commit(field: 'from' | 'to', id: string | null, source: CommitSource): void {
    if (this[field] === id) return;
    this[field] = id;
    this.loadMap();
    this.refresh();
    // Picked from the list with the other field still empty: go straight on to it.
    const other = field === 'from' ? this.toPicker : this.fromPicker;
    if (source === 'list' && id && !other.value) other.focus();
  }

  private pickFromMap(id: string): void {
    if (this.phase === 'play') return;
    if (!this.from) {
      this.from = id;
      this.fromPicker.value = id;
    } else {
      this.to = id;
      this.toPicker.value = id;
    }
    this.refresh();
  }

  private routeFrom(target: EventTarget | null): Route | null {
    const button = (target as HTMLElement | null)?.closest<HTMLElement>('[data-route]');
    return button ? (this.routes[Number(button.dataset.route)] ?? null) : null;
  }

  /* --------------------------------------------------------------- flow */

  /** Work out what the current pair of stations means, and show it. */
  private refresh(): void {
    this.ticket++;
    this.map?.stop();
    this.skipping = false;
    this.active = null;
    this.alternative = null;
    const { from, to } = this;
    this.routes = from && to && from !== to ? findRoutes(from, to) : [];

    if (!from && !to) this.phase = 'idle';
    else if (!from || !to) this.phase = 'half';
    else if (from === to) this.phase = 'walk';
    else if (!this.routes.length) this.phase = 'none';
    else this.phase = this.routes.length === 1 ? 'play' : 'choose';

    this.hintText =
      this.phase === 'idle'
        ? this.mapFailed
          ? copy.HINT.idleNoMap
          : copy.HINT.idle
        : this.phase === 'half'
          ? copy.pick(from ? copy.HINT.fromOnly : copy.HINT.toOnly)
          : '';

    this.heading = this.phase === 'choose' ? copy.optionsHeading(this.routes) : null;
    this.renderOptions();
    this.hideCaption();

    let result: copy.Result | null = null;
    if (this.phase === 'walk') result = copy.walkResult(from!);
    else if (this.phase === 'none') result = copy.noRouteResult(from!, to!);
    if (result) this.showResult(result);
    else this.hideResult();

    this.render();

    if (this.phase === 'play') {
      // One way to get there: no choice to make, the ride starts at once.
      void this.start(this.routes[0]);
      return;
    }
    this.applyToMap();
    if (from && to) this.showOutcome();
    if (this.heading) this.announce(copy.toPlain(`${this.heading.title}. ${this.heading.text}`));
    if (result) this.announce(resultText(result));
  }

  private async start(route: Route): Promise<void> {
    const ticket = ++this.ticket;
    this.map?.stop();
    this.active = route;
    this.phase = 'play';
    this.skipping = false;
    this.hideResult();
    this.render();
    this.dismissKeyboard();

    const map = await this.mapWithin(MAP_PATIENCE_MS);
    if (ticket !== this.ticket) return;
    if (!map || prefersReducedMotion()) {
      this.finish(route);
      return;
    }

    this.bringIntoView();
    this.map?.setPins(this.from, this.to);
    // Written once, so a caption shown twice reads the same both times.
    const script = copy.rideScript(route);
    this.showCaption(script.board[0], false);
    let outcome: 'done' | 'cancelled' = 'done';
    try {
      outcome = await map.play(route, {
        board: (i) => this.showCaption(script.board[i], true),
        change: (i) => this.showCaption(script.change[i], true),
        progress: (stage, i, t) => this.tick((stage === 'ride' ? script.board : script.change)[i], t),
        arrive: () => this.hideCaption(),
      });
    } catch (error) {
      // The ride is decoration: whatever went wrong, the reader still gets the answer.
      console.error('[game] ride failed:', error);
    }
    if (outcome === 'done' && ticket === this.ticket) this.finish(route);
  }

  private finish(route: Route): void {
    this.phase = 'done';
    this.hideCaption();
    const from = route.legs[0].from;
    const to = route.legs[route.legs.length - 1].to;
    this.alternative = readiness(route).kind === 'planning' ? findDatedRoute(from, to) : null;
    const result = copy.routeResult(route, this.alternative);
    const suggestion = this.alternative ? copy.datedSuggestion(route, this.alternative) : null;
    this.showResult(result, route, suggestion);
    this.render();
    // After the card is on screen, so the camera frames the trip around it.
    this.map?.setPins(this.from, this.to);
    this.map?.showTrip(route);
    this.announce(resultText(result, suggestion));
  }

  private skip(): void {
    if (this.phase !== 'play') return;
    this.skipping = true;
    this.hideCaption();
    this.map?.skip();
  }

  private reset(): void {
    const byKeyboard = document.activeElement?.matches(':focus-visible') ?? false;
    this.from = null;
    this.to = null;
    this.fromPicker.value = null;
    this.toPicker.value = null;
    this.refresh();
    // The button just pressed has gone; keep keyboard focus in the game.
    if (byKeyboard) this.panel.focus({ preventScroll: true });
  }

  /**
   * "Plan another trip" on the result card: start over, and take the reader
   * back to the station fields to choose again. On wide screens the panel sits
   * on the map, already in view; on phones it is above the map, off screen
   * after a ride.
   */
  private planAnother(): void {
    this.reset();
    this.reveal(this.panel);
  }

  /**
   * Both stations are in: put what comes next where the reader can see it.
   * Wide screens show the whole map, where the choice (or the answer) now is.
   * Phones close the keyboard first, which would otherwise cover it, then show
   * the choice of routes under the fields, or the map with the answer on it.
   */
  private showOutcome(): void {
    if (WIDE.matches) {
      this.bringIntoView();
      return;
    }
    this.dismissKeyboard();
    if (this.phase === 'choose') this.reveal(this.optionsList);
    else this.bringIntoView();
  }

  private preview(route: Route | null): void {
    if (!this.map || (this.phase !== 'choose' && this.phase !== 'done')) return;
    this.map.showRoute(route ?? this.active ?? this.routes[0] ?? null);
  }

  /* ---------------------------------------------------------------- map */

  private applyToMap(): void {
    const map = this.map;
    if (!map) return;
    map.setPins(this.from, this.to);
    switch (this.phase) {
      case 'idle':
        map.showRoute(null);
        map.overview();
        break;
      case 'half':
        map.showRoute(null);
        map.focusStation((this.from ?? this.to)!);
        break;
      case 'walk':
        map.showRoute(null);
        map.walk(this.from!);
        break;
      case 'none':
        map.showRoute(null);
        map.frameStations([this.from!, this.to!]);
        break;
      case 'choose':
        map.showRoute(this.routes[0]);
        map.frameRoutes(this.routes);
        break;
      case 'done':
        if (this.active) map.showTrip(this.active);
        break;
      default:
    }
  }

  private loadMapWhenNear(): void {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        // A second map's first frames (shaders, first tiles) are the heaviest work
        // on the page: measured at 290-480 ms a frame. Started mid-scroll they
        // stutter the page, so the map waits for the reader to pause, usually
        // over the cost chart just above. Touching the game starts it at once.
        whenStill(() => void this.loadMap());
      },
      { rootMargin: '100% 0px' },
    );
    observer.observe(this.root);
    this.root.addEventListener('focusin', () => this.loadMap(), { once: true });
  }

  private loadMap(): Promise<GameMap | null> {
    this.mapLoad ??= (async () => {
      const unsupported = mapUnsupportedReason();
      if (unsupported) throw new Error(unsupported);
      const [token, module] = await Promise.all([this.options.token(), import('./game-map')]);
      const map = await module.createGameMap({
        container: this.mapContainer,
        viewport: this.viewport,
        token,
        padding: () => this.padding(),
        onPick: (id) => this.pickFromMap(id),
        // A turned phone gets its view framed again; a ride in progress frames itself every frame.
        onResize: () => {
          if (this.phase !== 'play') this.applyToMap();
        },
      });
      this.map = map;
      if (import.meta.env.DEV) Object.assign(window, { __gameMap: map });
      // Catch up with anything picked while the map was loading.
      if (this.phase !== 'play') this.applyToMap();
      return map;
    })().catch((error: unknown) => {
      console.error('[game] map unavailable:', error);
      this.mapFailed = true;
      this.root.setAttribute('data-map-failed', '');
      this.fallback.hidden = false;
      if (this.phase === 'idle') this.hintText = copy.HINT.idleNoMap;
      // Without a map there is no middle of it: a waiting choice goes back under the fields.
      this.render();
      return null;
    });
    return this.mapLoad;
  }

  private mapWithin(ms: number): Promise<GameMap | null> {
    if (this.map || this.mapFailed) return Promise.resolve(this.map);
    return Promise.race([this.loadMap(), wait(ms)]);
  }

  /** Map area left clear of the panel and of the caption or result card on top of it. */
  private padding(): PaddingOptions {
    const w = this.viewport.clientWidth;
    const h = this.viewport.clientHeight;
    // Everything from the top of the caption or result card down to the map's bottom edge.
    let covered = 0;
    for (const el of [this.caption, this.result]) {
      if (!el.hidden && el.hasAttribute('data-visible')) covered = Math.max(covered, h - el.offsetTop);
    }
    const bottom = Math.round(Math.min(h * 0.62, covered ? covered + 28 : 48));
    // Top room for the station pins, which stand about 40px above their station.
    if (WIDE.matches) {
      const panelRight = this.panel.offsetLeft + this.panel.offsetWidth;
      return { top: 72, bottom, left: Math.round(Math.min(w * 0.5, panelRight + 48)), right: 64 };
    }
    return { top: 60, bottom, left: 36, right: 36 };
  }

  /* ---------------------------------------------------------------- DOM */

  private render(): void {
    this.root.dataset.phase = this.phase;
    this.resetButton.hidden = !(this.from || this.to);
    this.placeOptions();
    // With the choice out on the map, the panel says where it went.
    const hint = this.optionsList.hasAttribute('data-centered') ? copy.HINT.choose : this.hintText;
    this.hint.textContent = hint;
    this.hint.hidden = !hint;
    for (const button of this.optionsList.querySelectorAll<HTMLElement>('[data-route]')) {
      const route = this.routes[Number(button.dataset.route)];
      button.setAttribute('aria-pressed', String(Boolean(route && route.key === this.active?.key)));
    }
  }

  /**
   * Wide screens: while a choice of routes is waiting to be made, the options
   * leave the panel for a card in the middle of the map, which is where the
   * reader is looking once both stations are in. Tucked under the fields they
   * were easy to miss, and nothing moves until one is picked. Once a route is
   * chosen they go back under the fields, clear of the ride, where another
   * can still be tried. Phones keep them under the fields throughout: there
   * the panel sits directly above the map, in plain view.
   */
  private placeOptions(): void {
    const list = this.optionsList;
    const center = WIDE.matches && this.phase === 'choose' && !this.mapFailed;
    if (list.hasAttribute('data-centered') === center) return;
    // Moving an element drops focus from inside it: carry it along for keyboard readers.
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    if (center) this.viewport.insertBefore(list, this.caption);
    else this.panel.insertBefore(list, this.live);
    list.toggleAttribute('data-centered', center);
    focused?.focus({ preventScroll: true });
  }

  private renderOptions(): void {
    if (this.routes.length < 2) {
      this.optionsList.hidden = true;
      this.optionsList.innerHTML = '';
      return;
    }
    const heading = this.heading ?? copy.optionsHeading(this.routes);
    const tags = copy.routeTags(this.routes);
    const items = this.routes
      .map((route, i) => `<li>${routeButton(route, `data-route="${i}" aria-pressed="false"`, tags[i])}</li>`)
      .join('');
    this.optionsList.innerHTML = `
      <p class="game-options__kicker">${esc(copy.OPTIONS_KICKER)}</p>
      <p class="game-options__title">${esc(heading.title)}</p>
      <p class="game-options__text">${copy.toHtml(heading.text)}</p>
      <ul class="game-options__list" role="list">${items}</ul>`;
    this.optionsList.hidden = false;
  }

  private showCaption(caption: copy.Caption, announce: boolean): void {
    if (this.skipping) return;
    const lines = caption.lines.map(badge).join('<span class="game-caption__arrow" aria-hidden="true"></span>');
    const { from, total, exact } = caption.clock;
    // As wide as the total's digits, so the counting clock never nudges the figures after it.
    const clock = `<span class="game-caption__clock" aria-hidden="true">${CLOCK_ICON}<span class="game-caption__minute" style="min-width: ${String(total).length}ch" data-clock>${from}</span>&nbsp;of ${exact ? '' : '~'}${total}&nbsp;min</span>`;
    const figures = caption.figures.map((f) => `<span class="game-caption__figure">${copy.toHtml(f)}</span>`).join('');
    const html = `<span class="game-caption__badges">${lines}</span>
      <span class="game-caption__body">
        <span class="game-caption__title">${esc(caption.title)}</span>
        <span class="game-caption__text">${esc(caption.text)}</span>
        <span class="game-caption__meta">${clock}${figures}</span>
      </span>
      <button class="game-caption__skip" type="button" data-game-skip>Skip ride</button>`;
    const key = `${caption.title}|${caption.text}|${caption.lines.join()}`;
    if (this.caption.dataset.key !== key) {
      this.caption.dataset.key = key;
      this.caption.innerHTML = html;
      this.clockElement = this.caption.querySelector('[data-clock]');
      // Restart the swap-in animation for the new message.
      this.caption.removeAttribute('data-swap');
      void this.caption.offsetWidth;
      this.caption.setAttribute('data-swap', '');
    }
    this.clockCaption = caption;
    this.clockMinute = from;
    if (this.clockElement) this.clockElement.textContent = String(from);
    // Edge colours: the line being left on the left, the line ridden or boarded on the right.
    const first = caption.lines[0];
    const last = caption.lines[caption.lines.length - 1];
    this.caption.style.setProperty('--c-from', `var(--line-${first.toLowerCase()})`);
    this.caption.style.setProperty('--c', `var(--line-${last.toLowerCase()})`);
    this.caption.hidden = false;
    this.caption.inert = false;
    this.caption.setAttribute('data-visible', '');
    if (announce) this.announce(copy.toPlain(`${caption.title}. ${caption.text} ${caption.figures.join('. ')}.`));
  }

  /** Moves the caption's trip clock on as the train runs: `t` is how far through its ride or change, 0-1. */
  private tick(caption: copy.Caption | undefined, t: number): void {
    if (!caption || caption !== this.clockCaption || !this.clockElement) return;
    const minute = Math.round(caption.clock.from + (caption.clock.to - caption.clock.from) * t);
    // Only touch the DOM when the minute changes: a few dozen writes a ride, not one a frame.
    if (minute === this.clockMinute) return;
    this.clockMinute = minute;
    this.clockElement.textContent = String(minute);
  }

  private hideCaption(): void {
    // Keep focus somewhere sensible if the skip button had it.
    if (this.caption.contains(document.activeElement)) this.panel.focus({ preventScroll: true });
    this.caption.removeAttribute('data-visible');
    this.caption.inert = true;
    this.caption.dataset.key = '';
    this.clockCaption = null;
    this.clockElement = null;
  }

  private showResult(result: copy.Result, route?: Route, suggestion: copy.Suggestion | null = null): void {
    const figures = result.figures;
    let numbers = '';
    if (figures) {
      const stat = (label: string, s: copy.Stat) =>
        `<div class="stat"><dt class="stat__label">${esc(label)}</dt><dd class="stat__value">${copy.toHtml(s.value)}</dd><dd class="stat__note">${copy.toHtml(s.note)}</dd></div>`;
      numbers = `<dl class="game-result__stats">${stat(copy.STAT_LABELS.time, figures.time)}${stat(copy.STAT_LABELS.fare, figures.fare)}</dl>
        ${figures.quip ? `<p class="game-result__quip">${copy.toHtml(figures.quip)}</p>` : ''}`;
    }
    if (result.today) {
      numbers += `<div class="game-result__today">
          <p class="game-result__today-title">${copy.toHtml(result.today.title)}</p>
          <p class="game-result__today-text">${copy.toHtml(result.today.text)}</p>
        </div>`;
    }

    // Stops and distance, then where the numbers come from.
    const about = figures?.meta
      ? `<p class="game-result__meta">${esc(figures.meta)}</p>${figures.basis ? `<p class="game-result__basis">${esc(figures.basis)}</p>` : ''}`
      : '';
    let trip = '';
    if (route && figures?.steps.length) {
      // With changes: leg by leg, each ride with its time and fare, each change with its time.
      const rows = figures.steps.map((step) => {
        const mark = step.line
          ? `<span class="visually-hidden">${esc(LINES[step.line].name)}: </span>${badge(step.line)}`
          : '<span class="legs__dot"></span>';
        return `<li class="legs__row${step.line ? '' : ' legs__row--change'}">
          <span class="legs__mark">${mark}</span>
          <span class="legs__text"><span class="legs__name">${esc(step.text)}</span><span class="legs__detail">${copy.toHtml(step.detail)}</span></span>
          <span class="legs__time"><span class="visually-hidden">, </span>${copy.toHtml(step.time)}</span>
          <span class="legs__fare">${step.fare ? `<span class="visually-hidden">, </span>${copy.toHtml(step.fare)}` : ''}</span>
        </li>`;
      });
      // The ride's captions already went leg by leg, and the card sits over the map, so the
      // breakdown waits to be asked for. Without a ride (no map, reduced motion) it starts open.
      const watched = Boolean(this.map) && !prefersReducedMotion();
      trip = `<details class="game-result__steps"${watched ? '' : ' open'} data-game-steps>
          <summary class="game-result__steps-toggle">${esc(copy.STAT_LABELS.steps)}<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 6 8 10.5 12.5 6" /></svg></summary>
          <ol class="legs" aria-label="Your trip, leg by leg">${rows.join('')}</ol>
          ${about}
        </details>`;
    } else if (route) {
      const parts = [`<li class="trip__stop">${esc(copy.stationName(route.legs[0].from))}</li>`];
      for (const leg of route.legs) {
        parts.push(
          `<li class="trip__ride" style="--c: var(--line-${leg.line.toLowerCase()})"><span class="visually-hidden">${esc(
            LINES[leg.line].name,
          )} to</span>${badge(leg.line)}</li>`,
          `<li class="trip__stop">${esc(copy.stationName(leg.to))}</li>`,
        );
      }
      trip = `<ol class="trip" aria-label="Your trip">${parts.join('')}</ol>${about}`;
    }

    window.clearTimeout(this.closeTimer);
    this.result.removeAttribute('data-closing');
    this.result.innerHTML = `
      <button class="game-result__close" type="button" data-game-close aria-label="Close trip details">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
      <p class="game-result__kicker">${copy.toHtml(result.kicker)}</p>
      <h3 class="game-result__title">${copy.toHtml(result.title)}</h3>
      <p class="game-result__text">${copy.toHtml(result.text)}</p>
      ${numbers}
      ${trip}
      ${
        suggestion && this.alternative
          ? `<div class="game-result__alt">
              <p class="game-result__alt-title">${copy.toHtml(suggestion.title)}</p>
              <p class="game-result__alt-text">${copy.toHtml(suggestion.text)}</p>
              ${routeButton(this.alternative, 'data-game-alt')}
            </div>`
          : ''
      }
      <button class="game-btn${suggestion ? ' game-btn--quiet' : ''}" type="button" data-game-again>
        <svg class="game-btn__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" /></svg>
        Plan another trip
      </button>`;
    this.result.hidden = false;
    this.result.setAttribute('data-visible', '');
    // The card grows or shrinks with the breakdown: frame the trip again around it.
    this.result.querySelector('[data-game-steps]')?.addEventListener('toggle', () => {
      if (this.active && this.phase === 'done') this.map?.showTrip(this.active);
    });
    this.result.style.setProperty('--c', route ? `var(--line-${route.legs[route.legs.length - 1].line.toLowerCase()})` : 'var(--text-1)');
  }

  private hideResult(): void {
    window.clearTimeout(this.closeTimer);
    this.result.removeAttribute('data-closing');
    this.result.removeAttribute('data-visible');
    this.result.hidden = true;
    this.result.innerHTML = '';
  }

  /** The reader has seen the card: fade it out and give the map its room back. */
  private closeResult(): void {
    if (this.result.hidden || this.result.hasAttribute('data-closing')) return;
    // Its buttons are about to go: keep keyboard focus in the game.
    if (this.result.contains(document.activeElement)) this.panel.focus({ preventScroll: true });
    const close = () => {
      this.hideResult();
      // Frame the trip (or the stations) again, now with the whole map to use.
      this.applyToMap();
    };
    if (prefersReducedMotion()) {
      close();
      return;
    }
    this.result.setAttribute('data-closing', '');
    this.closeTimer = window.setTimeout(close, CLOSE_MS);
  }

  private announce(message: string): void {
    this.live.textContent = '';
    window.requestAnimationFrame(() => (this.live.textContent = message));
  }

  /** Phones: close the keyboard so the ride is not hidden behind it. */
  private dismissKeyboard(): void {
    const focused = document.activeElement;
    if (COARSE.matches && focused instanceof HTMLInputElement && this.root.contains(focused)) focused.blur();
  }

  /**
   * Scroll only as far as it takes to show `element` whole below the masthead,
   * or its top, when it is taller than the room. Nothing moves if it is
   * already in view.
   */
  private reveal(element: HTMLElement): void {
    const top = mastheadHeight() + 12;
    const bottom = window.innerHeight - 12;
    const rect = element.getBoundingClientRect();
    let offset = 0;
    if (rect.top < top || rect.height > bottom - top) offset = rect.top - top;
    else if (rect.bottom > bottom) offset = rect.bottom - bottom;
    if (Math.abs(offset) < 4) return;
    window.scrollTo({ top: window.scrollY + offset, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  /** Scroll so the whole map is on screen before the ride starts. */
  private bringIntoView(): void {
    const masthead = mastheadHeight();
    const rect = this.viewport.getBoundingClientRect();
    const vh = window.innerHeight;
    const room = vh - masthead;
    const onScreen = rect.top >= masthead - 8 && rect.bottom <= vh + 8;
    if (onScreen) return;
    const offset = rect.height <= room ? rect.top - masthead - (room - rect.height) / 2 : rect.top - masthead;
    window.scrollTo({ top: window.scrollY + offset, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
}
