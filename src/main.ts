// Game styles travel with the game chunk; see "the route game" below.
import './styles/fonts.css';
import './styles/main.css';
import './styles/costs.css';

import { Loader, wait } from './loader';
import { observeSteps } from './scroll/steps';
import { initTimeline } from './timeline';
import { initCosts } from './costs';
import { initNav } from './nav';
import { NetworkPanel } from './explorer/panel';
import { Dock } from './explorer/dock';
import { mapUnsupportedReason } from './map/support';
import { fetchMapToken, type MapToken } from './map/token';
import { prefersReducedMotion } from './lib/motion';
import type { StoryMap } from './map/story-map';

document.documentElement.classList.add('js');

/** The typefaces get this long before the story is shown in the fallback faces. */
const MAX_FONT_WAIT_MS = 3000;

const loader = new Loader();
loader.step(0.1);

const stage = document.querySelector<HTMLElement>('[data-stage]')!;
const mapContainer = document.querySelector<HTMLElement>('#map')!;
const steps = [...document.querySelectorAll<HTMLElement>('.steps [data-step]')];
const panel = new NetworkPanel(document.querySelector<HTMLElement>('[data-network-panel]')!);
const dock = new Dock(document.querySelector<HTMLElement>('[data-dock]')!);

let story: StoryMap | null = null;
let currentStep = 'hero';
/** While the page glides somewhere else, scenes wait until it lands. */
let holdScenes = false;

/* ----------------------------------------------------------- scroll steps */

observeSteps(steps, (id, element) => {
  currentStep = id;
  stage.dataset.step = id;
  // Charts inside a card grow once, the first time the card becomes active.
  element.querySelector('.card')?.setAttribute('data-revealed', '');
  // Leaving the explorer clears its selection; a sheet dragged taller must not come back half empty.
  if (id === 'network') dock.fitContent();
  if (!holdScenes) story?.go(id);
});

dock.onLayout(() => {
  if (currentStep === 'network') story?.refit();
});
// Registered before the map's own listener, so the explorer has its final size
// by the time the map measures it to frame a selection. Picking a line or a
// station also reopens a minimised tray, so the click visibly leads somewhere.
panel.onChange((selection) => {
  dock.fitContent();
  if (!selection) {
    dock.sync();
    return;
  }
  dock.reveal();
  // A station tapped on the map writes its detail into a box the reader may
  // have scrolled away from, or never scrolled at all. Carry it to the top of
  // that box so the answer arrives with the tap instead of waiting to be found.
  dock.showDetail(panel.detailBox);
});

/* --------------------------------------------------------------- the map */

function showFallback(error: unknown): void {
  console.error('[story] map unavailable:', error);
  stage.querySelector<HTMLElement>('[data-map-fallback]')?.removeAttribute('hidden');
}

/** One token request for the page: the story map and the route game share it. */
let tokenRequest: Promise<MapToken> | null = null;
const mapToken = (): Promise<MapToken> => (tokenRequest ??= fetchMapToken());

/**
 * Resolves once the loading screen is actually on screen. Everything the map
 * starts with (a WebGL test context, then mapbox's modules, shaders and first
 * render) keeps the main thread and the GPU busy, and begun straight away it
 * held the loading screen back: its first frame was drawn, then queued behind
 * the map's GPU work for a second or more, and the reader looked at a blank
 * page. The browser's own first-contentful-paint entry is reported once that
 * frame is presented. The map's files are already downloading (modulepreload
 * in <head>), so this costs the map a frame or two, not a download.
 *
 * A background tab paints nothing until it is brought forward, and mapbox
 * waits for that anyway, so there it goes straight on; so does a browser
 * without paint timing (after a frame), and the timeout is a last resort.
 */
function afterFirstPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (document.visibilityState !== 'visible') {
      resolve();
      return;
    }
    const supported = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('paint');
    if (!supported) {
      requestAnimationFrame(() => window.setTimeout(resolve, 0));
      return;
    }
    const observer = new PerformanceObserver((list) => {
      if (!list.getEntriesByName('first-contentful-paint').length) return;
      observer.disconnect();
      resolve();
    });
    observer.observe({ type: 'paint', buffered: true });
    window.setTimeout(() => {
      observer.disconnect();
      resolve();
    }, 1000);
  });
}

/**
 * Settles once the story map has drawn its opening view, or has failed for
 * good (no WebGL 2, no token, a chunk or the style that would not load). The
 * loading screen waits on exactly this: a reader never sees the story without
 * its map unless the map cannot be had.
 */
async function loadMap(): Promise<void> {
  await afterFirstPaint();
  const unsupported = mapUnsupportedReason();
  if (unsupported) {
    showFallback(new Error(unsupported));
    return;
  }
  try {
    // Token and map code in parallel; the code is already downloading thanks
    // to the modulepreload hints in <head>.
    const [token, module] = await Promise.all([
      mapToken(),
      import('./map/story-map').then((m) => {
        loader.step(0.4);
        return m;
      }),
    ]);
    story = await module.createStoryMap({ container: mapContainer, stage, panel, token });
    // Everything measurable is done; what is left is Mapbox pulling tiles over
    // the reader's connection, so the bar creeps the rest of the way.
    loader.step(0.7, 0.97);
    story.go(currentStep, { instant: true });

    if (import.meta.env.DEV) {
      Object.assign(window, { __story: story });
      // Review helper: /#step=kamlapur jumps straight to a scene.
      const target = /^#step=(.+)$/.exec(location.hash)?.[1];
      const el = target ? steps.find((s) => s.dataset.step === target) : undefined;
      if (el) {
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY);
        story.go(target!, { instant: true });
      }
    }

    // The loading screen lifts on `painted` (style up, opening tiles drawn),
    // not on `ready` (every tile settled and every fade finished), which can
    // trail it by seconds on a slow connection for no visible difference.
    void story.ready.then(() => performance.mark('story:map-ready'));
    await story.painted;
  } catch (error) {
    showFallback(error);
  }
}

// Start as soon as the loading screen is up: it covers the page, so there is
// no headline paint to protect, and every millisecond after it is map time.
const mapLoaded = loadMap();
// Reveal once the map has drawn its opening view and the typefaces are in (no
// swap flash). There is no short cap: on a slow connection the waiting lines
// keep the reader company instead of the story arriving without its map. The
// loader's own ceiling (src/loader.ts) covers a request that simply hangs.
const fontsLoaded = Promise.race([document.fonts?.ready ?? Promise.resolve(), wait(MAX_FONT_WAIT_MS)]);
void Promise.all([mapLoaded, fontsLoaded]).then(() => loader.finish());
void loader.done.then(() => {
  // Whatever lifted the screen, the stage never goes on hiding a half-drawn map.
  mapContainer.setAttribute('data-ready', '');
});

/* ---------------------------------------------- card fade without CSS support */

if (!CSS.supports('animation-timeline: view()')) {
  const fade = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const above = !entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);
        entry.target.toggleAttribute('data-past', above);
      }
    },
    { rootMargin: '-16% 0px 0px 0px' },
  );
  document.querySelectorAll('.steps .card').forEach((card) => fade.observe(card));
}

/* ------------------------------------------------------ page furniture */

const timeline = document.querySelector<HTMLOListElement>('[data-timeline]');
if (timeline) initTimeline(timeline);

const costsSection = document.querySelector<HTMLElement>('[data-costs]');
if (costsSection) initCosts(costsSection);

/* --------------------------------------------------------- the route game */

/**
 * The game is the largest single piece of the page's own script, and it sits
 * below the timeline and the cost chart. Loading it with the entry meant its
 * bytes raced the map for the same connection while the reader was looking at
 * a loading screen. Loading it at the first idle moment after that still built
 * it (two lists of 80 stations, its stylesheet) while the story map was busy
 * drawing its opening tiles, for every reader, including the many who never
 * scroll that far. So it waits until the reader is headed for it: the
 * timeline, two sections above it, coming within a screen; a jump from the
 * masthead; or a link straight to it. Its stylesheet travels in the same chunk.
 */
const gameRoot = document.querySelector<HTMLElement>('[data-game]');
let gameCode: Promise<typeof import('./game/game')> | null = null;
let gameRequest: Promise<unknown> | null = null;

/** The game's code, fetched once; a failed fetch can be tried again. */
function loadGameCode(): Promise<typeof import('./game/game')> {
  return (gameCode ??= import('./game/game').catch((error: unknown) => {
    gameCode = null;
    throw error;
  }));
}

function ensureGame(): Promise<unknown> {
  if (!gameRoot) return Promise.resolve();
  // A download dropped by a phone's connection should not leave the game missing for good: the next ask tries again.
  return (gameRequest ??= loadGameCode().then(
    (module) => module.initGame(gameRoot, { token: mapToken }),
    (error: unknown) => {
      gameRequest = null;
      throw error;
    },
  ));
}

function whenIdle(run: () => void): void {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 3000 });
  else window.setTimeout(run, 1200);
}

if (gameRoot) {
  // Only the download happens early, at the first idle moment once the story
  // is up, so that a jump to the game later does not wait on the network.
  void loader.done.then(() => whenIdle(() => void loadGameCode().catch(() => {})));

  // Linked to directly: the section has to exist before the browser can put
  // the reader in front of it.
  if (location.hash === '#game') void ensureGame();

  // Otherwise once the reader is on the way. Without IntersectionObserver (very
  // old browsers), once the story is up.
  const ahead = document.querySelector('.timeline');
  if (!('IntersectionObserver' in window)) void loader.done.then(() => ensureGame());
  if (ahead && 'IntersectionObserver' in window) {
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        near.disconnect();
        void ensureGame();
      },
      { rootMargin: '0px 0px 100% 0px' },
    );
    near.observe(ahead);
  }
}

/* ---------------------------------------------------------- section jumps */

const nav = document.querySelector<HTMLElement>('[data-sitenav]');
if (nav) {
  initNav(nav, {
    // The game section is `hidden` until its chunk arrives; without a box on
    // the page there is nothing for the browser to scroll to.
    prepare: (id) => (id === 'game' ? ensureGame().then(() => undefined) : undefined),
    onJump: () => holdSceneryUntilSettled(),
  });
}

const year = document.querySelector('[data-year]');
if (year) year.textContent = String(new Date().getFullYear());

// The footer carries the logo too; avoid showing it twice.
const masthead = document.querySelector<HTMLElement>('.masthead');
const footer = document.querySelector('.site-footer');
if (masthead && footer) {
  new IntersectionObserver(([entry]) => masthead.toggleAttribute('data-hidden', entry.isIntersecting)).observe(footer);
}
const scrolly = document.querySelector('.scrolly');
if (masthead && scrolly) {
  // A zero-height line at the top of the viewport: once the map section has
  // scrolled past it, the masthead gets a solid background.
  new IntersectionObserver(
    ([entry]) => masthead.toggleAttribute('data-solid', !entry.isIntersecting && entry.boundingClientRect.bottom < 1),
    { rootMargin: '0px 0px -100% 0px' },
  ).observe(scrolly);
}

/* ---------------------------------------------------------- back to top */

const toTop = document.querySelector<HTMLButtonElement>('[data-to-top]');
if (toTop && scrolly) {
  toTop.hidden = false;
  toTop.inert = true;
  let pastStory = false;
  let overGameMap = false;
  const sync = () => {
    const shown = pastStory && !overGameMap;
    toTop.toggleAttribute('data-visible', shown);
    toTop.inert = !shown;
  };
  // Appears once the map section has scrolled above the upper 40% of the
  // screen, i.e. the reader has moved on to the sections after it.
  new IntersectionObserver(
    ([entry]) => {
      pastStory = !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0) + 1;
      sync();
    },
    { rootMargin: '-40% 0px 0px 0px' },
  ).observe(scrolly);
  // ...and steps aside while the route game fills the bottom of the screen:
  // over the map it sat on the attribution and crowded the ride, and over the
  // trip panel on a phone it covered the times and fares of the route options.
  const gameStage = document.querySelector('.game__stage');
  if (gameStage) {
    new IntersectionObserver(
      ([entry]) => {
        overGameMap = entry.isIntersecting;
        sync();
      },
      { rootMargin: '-85% 0px 0px 0px' },
    ).observe(gameStage);
  }

  const hero = document.querySelector<HTMLElement>('.hero__title');
  toTop.addEventListener('click', () => {
    const smooth = !prefersReducedMotion();
    window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    holdSceneryUntilSettled(() => hero?.focus({ preventScroll: true }));
  });
}

/**
 * Gliding the length of the page passes through a dozen scenes in a second,
 * which would strobe the map. Let it rest on the view it is already showing
 * and move once, when the page arrives.
 */
function holdSceneryUntilSettled(then?: () => void): void {
  if (prefersReducedMotion()) {
    then?.();
    return;
  }
  holdScenes = true;
  whenScrollSettles(() => {
    holdScenes = false;
    story?.go(currentStep);
    then?.();
  });
}

/** Calls back once the page has stopped moving (works with or without `scrollend`). */
function whenScrollSettles(callback: () => void): void {
  let last = Number.NaN;
  let still = 0;
  const check = () => {
    const y = window.scrollY;
    if (Math.abs(y - last) < 1) {
      if (++still >= 3) {
        callback();
        return;
      }
    } else {
      still = 0;
      last = y;
    }
    window.setTimeout(check, 60);
  };
  window.setTimeout(check, 60);
}
