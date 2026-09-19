import { prefersReducedMotion } from './lib/motion';

/**
 * The section jumps in the masthead: The Map, Timeline, Price Tag, Plan a trip!
 *
 * Wide screens show all four in a row. Narrow ones keep only the ride, which
 * is the one thing a reader is most likely to want out of order, and fold the
 * rest into a tray behind a button beside it.
 *
 * The bar stays hidden in the markup until this runs: two of the four
 * sections, the map and the ride, are built by script, so with none there is
 * nowhere for half the links to go. From there the links are ordinary anchors
 * and the rest is polish: the tray, a smooth glide the story map can hold its
 * scenes through, and the current section marked as the page goes past it.
 */

const WIDE = window.matchMedia('(min-width: 900px)');

interface Options {
  /**
   * Called with the id being jumped to before the page starts moving. Anything
   * that has to exist first (the route game builds itself lazily) is awaited,
   * so the target has a box to scroll to by the time we scroll.
   */
  prepare?: (id: string) => void | Promise<void>;
  /** Called once a jump is under way, for anything that should sit still through it. */
  onJump?: (id: string) => void;
}

export function initNav(root: HTMLElement, options: Options = {}): void {
  const toggle = root.querySelector<HTMLButtonElement>('[data-sitenav-toggle]');
  const tray = root.querySelector<HTMLElement>('[data-sitenav-tray]');
  const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-nav-link]')];
  if (!toggle || !tray) return;

  root.removeAttribute('hidden');
  toggle.removeAttribute('hidden');

  /* ------------------------------------------------------------ the tray */

  let open = false;

  const setOpen = (next: boolean) => {
    if (next === open) return;
    open = next;
    root.toggleAttribute('data-open', next);
    toggle.setAttribute('aria-expanded', String(next));
  };

  toggle.addEventListener('click', () => setOpen(!open));

  // Anywhere outside closes it, including a tap on the map behind.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (open && !root.contains(event.target as Node)) setOpen(false);
    },
    { capture: true },
  );

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    setOpen(false);
    toggle.focus();
  });

  // Growing past the breakpoint lays the links out in a row; a tray left open
  // behind that would float over the page with nothing to close it.
  WIDE.addEventListener('change', () => {
    setOpen(false);
    // The same element is a row on one side of the breakpoint and a dropdown on
    // the other. Let it arrive in its new shape instead of fading between them,
    // which is what a tablet being turned over would otherwise show.
    tray.style.transition = 'none';
    requestAnimationFrame(() => requestAnimationFrame(() => (tray.style.transition = '')));
  });

  /* --------------------------------------------------------- the jumping */

  let jumps = 0;

  for (const link of links) {
    link.addEventListener('click', (event) => {
      // Let the browser handle anything it would handle differently anyway.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      const id = link.getAttribute('href')?.slice(1);
      if (!id) return;
      event.preventDefault();
      setOpen(false);
      void jump(id);
    });
  }

  async function jump(id: string): Promise<void> {
    // A section that could not be prepared (its chunk failed to arrive, say)
    // is still worth trying: the markup may already be on the page.
    await Promise.resolve(options.prepare?.(id)).catch(() => {});
    const target = document.getElementById(id);
    if (!target) return;
    options.onJump?.(id);
    // Sections not yet drawn stand in at an estimated height (content-visibility
    // in main.css). Draw them for the trip, so the page aims at where the target
    // really is and nothing above it changes size on the way.
    const html = document.documentElement;
    const trip = ++jumps;
    html.setAttribute('data-jumping', '');
    target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    // The address bar follows without the browser also jumping the page there.
    history.replaceState(null, '', `#${id}`);
    // A second jump mid-glide takes over; only the latest one tidies up.
    whenScrollEnds(() => {
      if (trip === jumps) html.removeAttribute('data-jumping');
    });
  }

  /* -------------------------------------------------------- what is on screen */

  if (!('IntersectionObserver' in window)) return;

  const byId = new Map<string, HTMLAnchorElement[]>();
  for (const link of links) {
    const id = link.getAttribute('href')?.slice(1);
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), link]);
  }

  const onScreen = new Set<string>();
  const order = [...byId.keys()];

  const mark = () => {
    // The furthest section down that is crossing the middle of the screen: the
    // sticky map step overlaps the ones after it, and the reader is in the later one.
    const current = [...order].reverse().find((id) => onScreen.has(id));
    for (const [id, group] of byId) {
      for (const link of group) link.toggleAttribute('data-current', id === current);
    }
  };

  // A thin band across the middle of the screen: whatever crosses it is what
  // the reader is looking at.
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.id;
        if (entry.isIntersecting) onScreen.add(id);
        else onScreen.delete(id);
      }
      mark();
    },
    { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
  );

  for (const id of byId.keys()) {
    const target = document.getElementById(id);
    if (target) spy.observe(target);
  }
}

/** Once the page stops moving: `scrollend` where there is one, a quiet spell otherwise. */
function whenScrollEnds(callback: () => void): void {
  let timer = 0;
  const done = () => {
    window.clearTimeout(timer);
    window.removeEventListener('scroll', restart);
    window.removeEventListener('scrollend', done);
    callback();
  };
  // No scrolling at all (already there) still has to finish.
  const restart = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(done, 'onscrollend' in window ? 3000 : 180);
  };
  window.addEventListener('scroll', restart, { passive: true });
  window.addEventListener('scrollend', done, { once: true });
  restart();
}
