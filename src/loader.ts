import { prefersReducedMotion } from './lib/motion';

/**
 * The loading screen painted by index.html before any script runs.
 *
 * The bar moves to real milestones (map code, token, style, first full
 * render) and, between them, creeps slowly toward the next one so it never
 * looks stuck. Everything is CSS transitions on `transform`: they keep
 * running smoothly on the compositor while the map code parses on the main
 * thread.
 */

const SCROLL_KEYS = new Set([' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End']);

export class Loader {
  private readonly root = document.querySelector<HTMLElement>('[data-loader]');
  private readonly bar = this.root?.querySelector<HTMLElement>('[data-loader-bar]') ?? null;
  private readonly status = this.root?.querySelector<HTMLElement>('[data-loader-status]') ?? null;
  private readonly main = document.querySelector<HTMLElement>('main');
  private value = 0.04;
  private creepTimer = 0;
  private finished = false;
  private readonly unlockScroll: () => void;

  constructor() {
    const html = document.documentElement;
    if (!this.root) {
      html.classList.add('is-ready');
      this.finished = true;
      this.unlockScroll = () => {};
      return;
    }
    html.classList.add('is-loading');
    this.main?.setAttribute('aria-busy', 'true');
    this.unlockScroll = lockScroll();
  }

  /**
   * Advance to a milestone (0-1), then drift toward `toward` until the next
   * milestone arrives. Transitions retarget from wherever the bar is, so a
   * milestone that lands mid-drift never jumps backwards.
   */
  step(value: number, status?: string, toward = Math.min(0.95, value + 0.2)): void {
    if (this.finished || !this.bar) return;
    if (status && this.status) this.status.dataset.status = status;
    if (value <= this.value) return;
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
    const root = this.root;
    const reduced = prefersReducedMotion();
    this.setBar(1, 240);

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
