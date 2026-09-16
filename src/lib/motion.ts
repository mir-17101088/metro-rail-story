/** Motion helpers shared by the map engine and the page. */

const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

export const prefersReducedMotion = (): boolean => reducedQuery.matches;

export function onReducedMotionChange(callback: (reduced: boolean) => void): void {
  reducedQuery.addEventListener('change', () => callback(reducedQuery.matches));
}

/** Cubic-bezier easing, solved numerically (same curve as the CSS tokens). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) break;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(Math.min(1, Math.max(0, t)));
  };
}

/** Strong ease-out: responsive entrances. */
export const easeOut = cubicBezier(0.23, 1, 0.32, 1);
/** Ease-in-out for things already on screen moving from A to B. */
export const easeInOut = cubicBezier(0.65, 0, 0.35, 1);
/** Gentle ease-in-out for trains between stations. */
export const easeTrain = (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * t);

/** Inverse of a monotonic easing function (bisection). */
export function invertEase(ease: (t: number) => number, y: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (ease(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export const clamp = (v: number, min = 0, max = 1): number => Math.min(max, Math.max(min, v));
