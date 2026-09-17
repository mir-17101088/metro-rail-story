import { prefersReducedMotion } from './lib/motion';

/**
 * Reveals the cost chart the first time it scrolls into view: each line's
 * revised cost travels out from its initial estimate. The chart is complete
 * without this (the figures are plain HTML); this only adds the motion.
 */
export function initCosts(chart: HTMLElement): void {
  if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
    chart.setAttribute('data-revealed', '');
    return;
  }
  const target = chart.querySelector('.costs__rows') ?? chart;
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      chart.setAttribute('data-revealed', '');
      observer.disconnect();
    },
    { rootMargin: '0px 0px -20% 0px' },
  );
  observer.observe(target);
}
