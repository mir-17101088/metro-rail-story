import type { PaddingOptions } from 'mapbox-gl/esm';
import { LINES, type LineId } from '../data/lines';
import { prefersReducedMotion } from '../lib/motion';
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
 * The page logic here works without the map (no WebGL, no token, or reduced
 * motion): the reader then gets the result card without the ride. The map
 * itself (mapbox, the train) is a separate chunk, loaded as the section nears
 * the screen.
 */

type Phase = 'idle' | 'half' | 'walk' | 'none' | 'choose' | 'play' | 'done';

interface Options {
  /** The page's shared Mapbox token request. */
  token: () => Promise<MapToken>;
  webgl: boolean;
}

const WIDE = window.matchMedia('(min-width: 1024px)');
const COARSE = window.matchMedia('(pointer: coarse)');
/** How long a ride waits for a map that is still loading before showing the result without it. */
const MAP_PATIENCE_MS = 6000;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const badge = (line: LineId) =>
  `<span class="badge badge--sm" style="--c: var(--line-${line.toLowerCase()})">${line}</span>`;

/** A route as a button: its line badges, where it changes, and when it can be ridden. */
function routeButton(route: Route, attributes: string): string {
  const lines = route.legs.map((leg) => leg.line);
  const spoken = lines.map((l) => LINES[l].name).join(', then ');
  return `<button class="route-btn" type="button" ${attributes}>
    <span class="route-btn__lines" aria-hidden="true">${lines.map(badge).join('<span class="route-btn__to"></span>')}</span>
    <span class="route-btn__text">
      <span class="route-btn__name">${esc(copy.routeName(route))}</span>
      <span class="route-btn__meta">${esc(copy.routeMeta(route))}<span class="visually-hidden">. ${esc(spoken)}.</span></span>
    </span>
    <span class="route-btn__go" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" /></svg></span>
  </button>`;
}

const wait = (ms: number) => new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms));

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
      if (target.closest('[data-game-again]')) this.reset();
      else if (target.closest('[data-game-alt]') && this.alternative) void this.start(this.alternative);
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

    this.renderOptions();
    this.hideCaption();

    if (this.phase === 'walk') this.showResult(copy.walkResult(from!));
    else if (this.phase === 'none') this.showResult(copy.noRouteResult(from!, to!));
    else this.hideResult();

    this.render();

    if (this.phase === 'play') {
      // One way to get there: no choice to make, the ride starts at once.
      void this.start(this.routes[0]);
      return;
    }
    this.applyToMap();
    // Wide screens: the panel rides on the map, so show the whole map once both stations are in.
    if (WIDE.matches && from && to) this.bringIntoView();
    if (this.phase === 'choose') this.announce(`${copy.optionsHeading(this.routes.length).title}.`);
    if (this.phase === 'walk' || this.phase === 'none') this.announce(this.result.textContent ?? '');
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
    this.showCaption(copy.boardCaption(route, 0), false);
    let outcome: 'done' | 'cancelled' = 'done';
    try {
      outcome = await map.play(route, {
        board: (i) => this.showCaption(copy.boardCaption(route, i), true),
        change: (i) => this.showCaption(copy.changeCaption(route, i), true),
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
    this.announce(copy.toPlain([result.title, result.text, suggestion?.title, suggestion?.text].filter(Boolean).join(' ')));
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
        this.loadMap();
      },
      { rootMargin: '100% 0px' },
    );
    observer.observe(this.root);
    this.root.addEventListener('focusin', () => this.loadMap(), { once: true });
  }

  private loadMap(): Promise<GameMap | null> {
    this.mapLoad ??= (async () => {
      if (!this.options.webgl) throw new Error('WebGL is not available');
      const [token, module] = await Promise.all([this.options.token(), import('./game-map')]);
      const map = await module.createGameMap({
        container: this.mapContainer,
        viewport: this.viewport,
        token,
        padding: () => this.padding(),
        onPick: (id) => this.pickFromMap(id),
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
      if (this.phase === 'idle') {
        this.hintText = copy.HINT.idleNoMap;
        this.render();
      }
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
    this.hint.textContent = this.hintText;
    this.hint.hidden = !this.hintText;
    for (const button of this.optionsList.querySelectorAll<HTMLElement>('[data-route]')) {
      const route = this.routes[Number(button.dataset.route)];
      button.setAttribute('aria-pressed', String(Boolean(route && route.key === this.active?.key)));
    }
  }

  private renderOptions(): void {
    if (this.routes.length < 2) {
      this.optionsList.hidden = true;
      this.optionsList.innerHTML = '';
      return;
    }
    const heading = copy.optionsHeading(this.routes.length);
    const items = this.routes
      .map((route, i) => `<li>${routeButton(route, `data-route="${i}" aria-pressed="false"`)}</li>`)
      .join('');
    this.optionsList.innerHTML = `
      <p class="game-options__title">${esc(heading.title)}</p>
      <p class="game-options__text">${esc(heading.text)}</p>
      <ul class="game-options__list" role="list">${items}</ul>`;
    this.optionsList.hidden = false;
  }

  private showCaption(caption: copy.Caption, announce: boolean): void {
    if (this.skipping) return;
    const lines = caption.lines.map(badge).join('<span class="game-caption__arrow" aria-hidden="true"></span>');
    const html = `<span class="game-caption__badges">${lines}</span>
      <span class="game-caption__body">
        <span class="game-caption__title">${esc(caption.title)}</span>
        <span class="game-caption__text">${esc(caption.text)}</span>
      </span>
      <button class="game-caption__skip" type="button" data-game-skip>Skip ride</button>`;
    const key = `${caption.title}|${caption.lines.join()}`;
    if (this.caption.dataset.key !== key) {
      this.caption.dataset.key = key;
      this.caption.innerHTML = html;
      // Restart the swap-in animation for the new message.
      this.caption.removeAttribute('data-swap');
      void this.caption.offsetWidth;
      this.caption.setAttribute('data-swap', '');
    }
    const last = caption.lines[caption.lines.length - 1];
    this.caption.style.setProperty('--c', `var(--line-${last.toLowerCase()})`);
    this.caption.hidden = false;
    this.caption.inert = false;
    this.caption.setAttribute('data-visible', '');
    if (announce) this.announce(`${caption.title}. ${caption.text}`);
  }

  private hideCaption(): void {
    // Keep focus somewhere sensible if the skip button had it.
    if (this.caption.contains(document.activeElement)) this.panel.focus({ preventScroll: true });
    this.caption.removeAttribute('data-visible');
    this.caption.inert = true;
    this.caption.dataset.key = '';
  }

  private showResult(result: copy.Result, route?: Route, suggestion: copy.Suggestion | null = null): void {
    let trip = '';
    if (route) {
      const parts = [`<li class="trip__stop">${esc(copy.stationName(route.legs[0].from))}</li>`];
      for (const leg of route.legs) {
        parts.push(
          `<li class="trip__ride" style="--c: var(--line-${leg.line.toLowerCase()})"><span class="visually-hidden">${esc(
            LINES[leg.line].name,
          )} to</span>${badge(leg.line)}</li>`,
          `<li class="trip__stop">${esc(copy.stationName(leg.to))}</li>`,
        );
      }
      const changes = copy.changes(route.changes.length);
      trip = `<ol class="trip" aria-label="Your trip">${parts.join('')}</ol>
        <p class="game-result__meta">${esc(changes)} · ${esc(copy.stops(route.stops))}</p>`;
    }
    this.result.innerHTML = `
      <p class="game-result__kicker">${copy.toHtml(result.kicker)}</p>
      <h3 class="game-result__title">${copy.toHtml(result.title)}</h3>
      <p class="game-result__text">${copy.toHtml(result.text)}</p>
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
    this.result.style.setProperty('--c', route ? `var(--line-${route.legs[route.legs.length - 1].line.toLowerCase()})` : 'var(--text-1)');
  }

  private hideResult(): void {
    this.result.removeAttribute('data-visible');
    this.result.hidden = true;
    this.result.innerHTML = '';
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

  /** Scroll so the whole map is on screen before the ride starts. */
  private bringIntoView(): void {
    const masthead = document.querySelector('.masthead')?.getBoundingClientRect().height ?? 68;
    const rect = this.viewport.getBoundingClientRect();
    const vh = window.innerHeight;
    const room = vh - masthead;
    const onScreen = rect.top >= masthead - 8 && rect.bottom <= vh + 8;
    if (onScreen) return;
    const offset = rect.height <= room ? rect.top - masthead - (room - rect.height) / 2 : rect.top - masthead;
    window.scrollTo({ top: window.scrollY + offset, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
}
