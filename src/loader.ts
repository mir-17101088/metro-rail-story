import { prefersReducedMotion } from './lib/motion';

/**
 * The loading screen painted by index.html before any script runs.
 *
 * The bar moves to real milestones (map code, token, style, first full
 * render) and, between them, creeps slowly toward the next one so it never
 * looks stuck. Everything is CSS transitions on `transform`: they keep
 * running smoothly on the compositor while the map code parses on the main
 * thread.
 *
 * The bar is the progress. The line under it is not: "Laying the tracks" told
 * a reader nothing they could use, so it carries the waiting lines instead,
 * which at least keep them company while Mapbox pulls tiles down a connection
 * we do not control. index.html paints the first one before any script runs;
 * this picks up from there. On a quick connection only that first one is seen.
 *
 * The screen stays until main.ts calls `finish`: once the map has drawn its
 * opening view, or has failed for good. index.html also carries a CSS-only
 * failsafe for when no script runs at all; once this one runs it takes over
 * from it, since on a slow connection the map can legitimately take longer
 * than that failsafe allows. Its own ceiling only catches a request that hangs.
 */

const SCROLL_KEYS = new Set([' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End']);

/**
 * Long enough for the map to arrive over a poor mobile connection; reached
 * only when something has stopped answering altogether (ms since navigation).
 */
const CEILING_MS = 60000;

/**
 * Shown in turn while the map loads. The first is in index.html, so this list
 * has to start with the same one; the rotation begins at the second.
 */
const WAITING_LINES = [
  'Stuck in traffic',
  'Your internet is probably slow',
  'Waiting at the signal',
  'Dodging a Bangla Tesla',
  'Still quicker than Gulistan',
  'Counting the pillars',
  'Buying a single journey ticket',
  'Please mind the gap',
  'The next train is approaching',
  'Blaming it on the traffic',
  'Almost at the platform',
];

/** How long a line holds before the next one. */
const LINE_MS = 2600;
/** Cross-fade between two lines. */
const SWAP_MS = 200;

export class Loader {
  private readonly root = document.querySelector<HTMLElement>('[data-loader]');
  private readonly bar = this.root?.querySelector<HTMLElement>('[data-loader-bar]') ?? null;
  private readonly status = this.root?.querySelector<HTMLElement>('[data-loader-status]') ?? null;
  private readonly main = document.querySelector<HTMLElement>('main');
  private value = 0.04;
  private creepTimer = 0;
  private lineTimer = 0;
  /** index.html painted WAITING_LINES[0] already; the rotation goes on from it. */
  private lineIndex = 0;
  private finished = false;
  private readonly unlockScroll: () => void;
  private resolveDone: () => void = () => {};

  /** Settles when the screen starts to lift, whatever lifted it. */
  readonly done = new Promise<void>((resolve) => (this.resolveDone = resolve));

  constructor() {
    const html = document.documentElement;
    if (!this.root) {
      html.classList.add('is-ready');
      this.finished = true;
      this.unlockScroll = () => {};
      this.resolveDone();
      return;
    }
    html.classList.add('is-loading');
    this.main?.setAttribute('aria-busy', 'true');
    this.unlockScroll = lockScroll();
    // Scripts that arrive after index.html's failsafe has already lifted the
    // screen must not bring it back over a page the reader is using.
    if (getComputedStyle(this.root).visibility === 'hidden') {
      this.finish();
      return;
    }
    // Scripts are running: from here the map decides, not index.html's timer.
    this.root.style.animation = 'none';
    this.armLines(LINE_MS);
    window.setTimeout(() => {
      if (this.finished) return;
      console.warn('[loader] the map has not drawn after %d s; showing the story anyway', CEILING_MS / 1000);
      this.finish();
    }, Math.max(0, CEILING_MS - performance.now()));
  }

  /**
   * Advance to a milestone (0-1), then drift toward `toward` until the next
   * milestone arrives. Transitions retarget from wherever the bar is, so a
   * milestone that lands mid-drift never jumps backwards.
   */
  step(value: number, toward = Math.min(0.95, value + 0.2)): void {
    if (this.finished || !this.bar || value <= this.value) return;
    this.value = value;
    this.setBar(value, 600);
    window.clearTimeout(this.creepTimer);
    this.creepTimer = window.setTimeout(() => this.setBar(value + (toward - value) * 0.9, 9000, true), 620);
  }

  /** Complete the bar, fade the screen out and hand the page to the reader. */
  finish(): void {
    if (this.finished || !this.root) return;
    this.finished = true;
    // Visible in DevTools > Performance, or via performance.getEntriesByName('story:revealed').
    performance.mark('story:revealed');
    window.clearTimeout(this.creepTimer);
    window.clearTimeout(this.lineTimer);
    const root = this.root;
    const reduced = prefersReducedMotion();
    this.setBar(1, 240);
    this.resolveDone();

    window.setTimeout(
      () => {
        root.setAttribute('data-done', '');
        const html = document.documentElement;
        html.classList.remove('is-loading');
        html.classList.add('is-ready');
        this.main?.removeAttribute('aria-busy');
        this.unlockScroll();
        window.setTimeout(() => root.remove(), 700);
      },
      reduced ? 0 : 260,
    );
  }

  /** Show the next waiting line after `delay`, then keep going every LINE_MS. */
  private armLines(delay: number): void {
    window.clearTimeout(this.lineTimer);
    const status = this.status;
    if (this.finished || !status) return;
    this.lineTimer = window.setTimeout(() => {
      this.lineIndex = (this.lineIndex + 1) % WAITING_LINES.length;
      const text = WAITING_LINES[this.lineIndex];
      // Fade out, swap, fade back: the two lines never overlap mid-word.
      status.style.opacity = '0';
      window.setTimeout(() => {
        if (this.finished) return;
        status.dataset.status = text;
        status.style.opacity = '';
      }, SWAP_MS);
      this.armLines(LINE_MS);
    }, delay);
  }

  private setBar(value: number, duration: number, drift = false): void {
    if (!this.bar) return;
    // Drift decelerates hard: most of its travel happens early, then it barely moves.
    const easing = drift ? 'cubic-bezier(0.05, 0.7, 0.1, 1)' : 'cubic-bezier(0.23, 1, 0.32, 1)';
    this.bar.style.transition = `transform ${duration}ms ${easing}`;
    this.bar.style.transform = `scaleX(${Math.min(1, value).toFixed(3)})`;
  }
}

/**
 * Hold the page still while the loading screen is up. Listeners rather than
 * `overflow: hidden`, so the scrollbar never disappears (no layout shift at
 * reveal) and the browser can still restore a reader's scroll position.
 */
function lockScroll(): () => void {
  const block = (event: Event) => event.preventDefault();
  const blockKeys = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) event.preventDefault();
  };
  window.addEventListener('wheel', block, { passive: false });
  window.addEventListener('touchmove', block, { passive: false });
  window.addEventListener('keydown', blockKeys);
  return () => {
    window.removeEventListener('wheel', block);
    window.removeEventListener('touchmove', block);
    window.removeEventListener('keydown', blockKeys);
  };
}

export const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
