/**
 * Scroll step activation without scroll listeners.
 *
 * Steps tile the page vertically, so exactly one step crosses a thin trigger
 * line. The line sits just above the bottom edge of the screen: a step (and
 * its map scene) activates the moment its card peeks into view, while the
 * previous card is on its way out at the top. Scrolling back up reverses it at
 * the same place, so both directions feel identical.
 *
 * An IntersectionObserver whose root is shrunk to that 1px line tells us which
 * step is under it.
 */

/** Distance of the trigger line above the bottom edge: ~4% of the screen, 20-48px. */
const triggerOffset = (vh: number) => Math.round(Math.min(48, Math.max(20, vh * 0.04)));

export type StepHandler = (id: string, element: HTMLElement, index: number) => void;

export function observeSteps(steps: HTMLElement[], onStep: StepHandler): () => void {
  let observer: IntersectionObserver | null = null;
  let active = -1;
  let lastHeight = 0;

  const connect = () => {
    observer?.disconnect();
    const vh = Math.max(window.innerHeight, document.documentElement.clientHeight, 2);
    lastHeight = vh;
    const top = vh - triggerOffset(vh);
    const bottom = Math.max(0, vh - top - 1);
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = steps.indexOf(entry.target as HTMLElement);
          if (index === active || index < 0) continue;
          active = index;
          const el = steps[index];
          onStep(el.dataset.step ?? '', el, index);
        }
      },
      { rootMargin: `${-top}px 0px ${-bottom}px 0px`, threshold: 0 },
    );
    steps.forEach((s) => observer!.observe(s));
  };

  // After the first frame: measured during start-up, the viewport height forced
  // the whole page's first layout inside the start-up script, ahead of the
  // loading screen's first paint. Once a frame is out, the layout is there to read.
  requestAnimationFrame(() => window.setTimeout(() => lastHeight || connect(), 0));

  // Mobile browsers change innerHeight as the toolbar hides; only reconnect on
  // real layout changes to avoid re-triggering steps mid-scroll.
  let timer = 0;
  const onResize = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (Math.abs(window.innerHeight - lastHeight) > 120) connect();
    }, 150);
  };
  window.addEventListener('resize', onResize, { passive: true });

  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', onResize);
  };
}
