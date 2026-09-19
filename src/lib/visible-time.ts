/**
 * Calls `callback` once the page has been visible for `ms` in all.
 *
 * For timeouts on map work. Mapbox does its work on animation frames (even
 * applying a style waits for one), and a tab opened in the background gets
 * none until it is brought forward. Counted in plain time, a story opened in
 * a background tab gave up on its map before the reader ever looked at it and
 * greeted them with the "could not load" fallback; counted in visible time, the
 * map simply starts when the tab does.
 *
 * Returns a function that cancels it.
 */
export function afterVisibleTime(ms: number, callback: () => void): () => void {
  let left = ms;
  let since = 0;
  let timer = 0;

  const run = () => {
    since = performance.now();
    timer = window.setTimeout(() => {
      cancel();
      callback();
    }, Math.max(0, left));
  };

  const onVisibility = () => {
    const visible = document.visibilityState === 'visible';
    if (visible && !timer) run();
    else if (!visible && timer) {
      window.clearTimeout(timer);
      timer = 0;
      left -= performance.now() - since;
    }
  };

  const cancel = () => {
    window.clearTimeout(timer);
    timer = 0;
    document.removeEventListener('visibilitychange', onVisibility);
  };

  document.addEventListener('visibilitychange', onVisibility);
  if (document.visibilityState === 'visible') run();
  return cancel;
}
