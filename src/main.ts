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
import { fetchMapToken, type MapToken } from './map/token';
import { prefersReducedMotion } from './lib/motion';
import type { StoryMap } from './map/story-map';

document.documentElement.classList.add('js');

/** The loading screen never stays up longer than this (ms since navigation). */
const MAX_LOADING_MS = 9000;
/** ...and it does not wait on a slow tile server past this, either. */
const MAX_MAP_WAIT_MS = 5000;
/** However long the map takes, the stage stops hiding it after this. */
const MAX_HIDDEN_MS = 8000;

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

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

async function loadMap(): Promise<void> {
  if (!webglAvailable()) {
    showFallback(new Error('WebGL is not available'));
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

    // The stage fades the map in on `painted` (style up, first tiles drawn),
    // not on `ready` (every tile in the viewport settled). Waiting for the
    // latter is what used to leave a reader on a blank stage when the loading
    // screen timed out first.
    void story.ready.then(() => performance.mark('story:map-ready'));
    await Promise.race([story.painted, wait(MAX_MAP_WAIT_MS)]);
  } catch (error) {
    showFallback(error);
  }
}

// Start immediately: the loading screen is already covering the page, so there
// is no headline paint to protect, and every millisecond here is map time.
const mapLoaded = loadMap();
// Last resort: a map still short of its first full frame is shown anyway rather
// than leaving the stage empty behind a loading screen that has already gone.
window.setTimeout(() => mapContainer.setAttribute('data-ready', ''), MAX_HIDDEN_MS);
// Reveal once the map has rendered and the typefaces are in (no swap flash),
// or when the cap is reached; a slow map then fades in on its own.
const fontsLoaded = Promise.race([document.fonts?.ready ?? Promise.resolve(), wait(3000)]);
void Promise.race([
  Promise.all([mapLoaded, fontsLoaded]),
  wait(Math.max(0, MAX_LOADING_MS - performance.now())),
]).then(() => {
  loader.finish();
  whenIdle(() => void ensureGame());
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
 * a loading screen, so it is fetched once the story is readable instead: at
 * the first idle moment, or sooner if the reader is already scrolling towards
 * it. Its stylesheet travels in the same chunk.
 */
const gameRoot = document.querySelector<HTMLElement>('[data-game]');
let gameRequest: Promise<unknown> | null = null;

function ensureGame(): Promise<unknown> {
  if (!gameRoot) return Promise.resolve();
  return (gameRequest ??= import('./game/game').then((module) =>
    module.initGame(gameRoot, { token: mapToken, webgl: webglAvailable() }),
  ));
}

function whenIdle(run: () => void): void {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 3000 });
  else window.setTimeout(run, 1200);
}

if (gameRoot) {
  // Linked to directly: the section has to exist before the browser can put
  // the reader in front of it.
  if (location.hash === '#game') void ensureGame();

  // Otherwise, whichever comes first: the page falling quiet, or the reader arriving.
  const ahead = document.querySelector('.timeline');
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
  // Appears once the map section has scrolled above the upper 40% of the
  // screen, i.e. the reader has moved on to the sections after it.
  new IntersectionObserver(
    ([entry]) => {
      const past = !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0) + 1;
      toTop.toggleAttribute('data-visible', past);
      toTop.inert = !past;
    },
    { rootMargin: '-40% 0px 0px 0px' },
  ).observe(scrolly);

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
