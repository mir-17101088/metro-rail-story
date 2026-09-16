import { prefersReducedMotion } from './lib/motion';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const years = (a: Date, b: Date) => Math.abs(b.getTime() - a.getTime()) / (365.25 * 24 * 3600 * 1000);

/**
 * Splits the timeline into what has happened and what is still planned
 * (solid vs dashed axis, echoing the map's dashed unfinished track), inserts a
 * "today" mark at its proportional place, and reveals items as they scroll in.
 * Labels only: nothing here is clickable.
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
    const prevDate = new Date(previous.dataset.date!);
    const nextDate = new Date(insertBefore.dataset.date!);
    const today = document.createElement('li');
    today.className = 'tl__item tl__item--today';
    today.style.setProperty('--gap', years(prevDate, now).toFixed(2));
    today.innerHTML = `<span class="tl__date">Today</span><span class="tl__today-text">${MONTHS[now.getMonth()]} ${now.getFullYear()}</span>`;
    list.insertBefore(today, insertBefore);
    insertBefore.style.setProperty('--gap', years(now, nextDate).toFixed(2));
    items.splice(items.indexOf(insertBefore), 0, today);
  }

  if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
    items.forEach((i) => i.setAttribute('data-visible', ''));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute('data-visible', '');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -12% 0px' },
  );
  items.forEach((i) => observer.observe(i));
}
