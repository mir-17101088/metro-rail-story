import '@fontsource-variable/newsreader/wght.css';
import '@fontsource-variable/libre-franklin/wght.css';
import './styles/main.css';

import { Loader, wait } from './loader';
import { observeSteps } from './scroll/steps';
import { initTimeline } from './timeline';
import { NetworkPanel } from './explorer/panel';
import { Dock } from './explorer/dock';
import { fetchMapToken } from './map/token';
import { prefersReducedMotion } from './lib/motion';
import type { StoryMap } from './map/story-map';

document.documentElement.classList.add('js');

/** The loading screen never stays up longer than this (ms since navigation). */
const MAX_LOADING_MS = 12000;

const loader = new Loader();
loader.step(0.1, 'Loading the map');

const stage = document.querySelector<HTMLElement>('[data-stage]')!;
const mapContainer = document.querySelector<HTMLElement>('#map')!;
const steps = [...document.querySelectorAll<HTMLElement>('.steps [data-step]')];
const panel = new NetworkPanel(document.querySelector<HTMLElement>('[data-network-panel]')!);
const dock = new Dock(document.querySelector<HTMLElement>('[data-dock]')!);

let story: StoryMap | null = null;
let currentStep = 'hero';
/** While the page glides back to the top, scenes wait until it lands. */
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
  if (selection) dock.reveal();
});

/* --------------------------------------------------------------- the map */

function showFallback(error: unknown): void {
  console.error('[story] map unavailable:', error);
  stage.querySelector<HTMLElement>('[data-map-fallback]')?.removeAttribute('hidden');
}

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
      fetchMapToken(),
      import('./map/story-map').then((m) => {
        loader.step(0.4, 'Laying the tracks');
        return m;
      }),
    ]);
    story = await module.createStoryMap({ container: mapContainer, stage, panel, token });
    loader.step(0.7, 'Drawing the network', 0.97);
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

    await story.ready;
    performance.mark('story:map-ready');
  } catch (error) {
    showFallback(error);
  }
}

// Start immediately: the loading screen is already covering the page, so there
// is no headline paint to protect, and every millisecond here is map time.
const mapLoaded = loadMap();
// Reveal once the map has rendered and the typefaces are in (no swap flash),
// or when the cap is reached; a slow map then fades in on its own.
const fontsLoaded = Promise.race([document.fonts?.ready ?? Promise.resolve(), wait(3000)]);
void Promise.race([
  Promise.all([mapLoaded, fontsLoaded]),
  wait(Math.max(0, MAX_LOADING_MS - performance.now())),
]).then(() => loader.finish());

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
    // Gliding through a dozen scenes in a second would strobe the map; let it
    // rest on the current view and move once, when the page arrives.
    holdScenes = smooth;
    window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    whenScrollSettles(() => {
      holdScenes = false;
      story?.go(currentStep);
      hero?.focus({ preventScroll: true });
    });
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
