import { CONFIG } from '../config';

export interface MapToken {
  token: string;
  /** Epoch ms, or null for a non-expiring (URL-restricted) public token. */
  expires: number | null;
}

/**
 * A URL-restricted public token compiled in at build time. Set it for static
 * hosting (no server endpoint) and for the fastest start: the map begins
 * loading without an extra round trip.
 */
const BUILD_TOKEN = ((import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN as string | undefined) ?? '').trim();

/**
 * Resolve a map token: the build-time public token when there is one,
 * otherwise ask our own server (Vercel / Node) for a short-lived token.
 */
export async function fetchMapToken(signal?: AbortSignal): Promise<MapToken> {
  if (BUILD_TOKEN.startsWith('pk.')) return { token: BUILD_TOKEN, expires: null };
  return requestServerToken(signal);
}

async function requestServerToken(signal?: AbortSignal): Promise<MapToken> {
  const url = new URL(CONFIG.tokenUrl, document.baseURI);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`Map token request failed (${response.status})`);
  const body = (await response.json()) as { token?: unknown; expires?: unknown };
  if (typeof body.token !== 'string' || !body.token) throw new Error('Map token response was empty');
  const expires = typeof body.expires === 'string' ? Date.parse(body.expires) : null;
  return { token: body.token, expires: Number.isFinite(expires) ? expires : null };
}

/**
 * Temporary tokens last under an hour. Swap in a fresh one before expiry so a
 * reader who leaves the tab open keeps loading tiles.
 */
export function keepTokenFresh(current: MapToken, apply: (token: string) => void): () => void {
  let timer = 0;
  let stopped = false;

  const schedule = (token: MapToken) => {
    if (stopped || token.expires === null) return;
    const wait = Math.max(30_000, token.expires - Date.now() - 5 * 60_000);
    timer = window.setTimeout(async () => {
      try {
        const next = await requestServerToken();
        apply(next.token);
        schedule(next);
      } catch {
        // Try again shortly; tiles already on screen stay visible meanwhile.
        schedule({ token: token.token, expires: Date.now() + 5 * 60_000 + 60_000 });
      }
    }, wait);
  };

  schedule(current);
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}
