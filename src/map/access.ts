import { setAccessToken } from 'mapbox-gl/esm';
import { keepTokenFresh, type MapToken } from './token';

let applied = false;

/**
 * mapbox-gl keeps one global token for every map on the page (the story map
 * and the route game). Set it, and start refreshing it, only once.
 */
export function applyToken(token: MapToken): void {
  if (applied) return;
  applied = true;
  setAccessToken(token.token);
  keepTokenFresh(token, (next) => setAccessToken(next));
}
