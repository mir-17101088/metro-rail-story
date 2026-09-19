import { prefersReducedMotion } from './lib/motion';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Splits the timeline into what has happened and what is still planned
 * (solid vs dashed axis, echoing the map's dashed unfinished track), drops a
 * "today" mark between the last event and the next one, and reveals items as
 * they scroll in. Labels only: nothing here is clickable.
 *
 * Spacing is one fixed step per event, not one scaled to the years between
 * them: a list that ran from 2005 to 2036 left huge voids around the sparse
 * years and crammed 2026-2027 together. Every entry now reads at the same
 * rhythm, and the dates themselves carry the passage of time.
 */
export function initTimeline(list: HTMLOListElement): void {
  const items = [...list.querySelectorAll<HTMLLIElement>('.tl__item')];
  const now = new Date();

  let insertBefore: HTMLLIElement | null = null;
  let previous: HTMLLIElement | null = null;
  for (const item of items) {
    const date = new Date(item.dataset.date ?? '');
    if (Number.isNaN(date.getTime())) continue;
    if (date > now) {
      item.setAttribute('data-future', '');
      if (!insertBefore) insertBefore = item;
    } else {
      previous = item;
    }
  }

  if (insertBefore && previous) {
    const today = document.createElement('li');
    today.className = 'tl__item tl__item--today';
    today.innerHTML = `<span class="tl__date">Today</span><span class="tl__today-text">${MONTHS[now.getMonth()]} ${now.getFullYear()}</span>`;
    list.insertBefore(today, insertBefore);
    items.splice(items.indexOf(insertBefore), 0, today);
  }

  if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
    items.forEach((i) => i.setAttribute('data-visible', ''));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      // Items arriving together (a section jump, a fast flick) rise one after
      // another rather than as a block; one on its own rises at once.
      let order = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const item = entry.target as HTMLElement;
        item.style.transitionDelay = `${Math.min(order++, 5) * 60}ms`;
        item.setAttribute('data-visible', '');
        observer.unobserve(item);
      }
    },
    { rootMargin: '0px 0px -12% 0px' },
  );
  items.forEach((i) => observer.observe(i));
}
