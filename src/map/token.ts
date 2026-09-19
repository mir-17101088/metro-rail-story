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
 * A token request that has not answered by now is not going to. The loading
 * screen waits for the map, so a hung request must turn into a failure (and
 * the fallback) rather than an endless wait.
 */
const REQUEST_TIMEOUT_MS = 10000;
/** One retry: a serverless endpoint's cold start, or a dropped mobile connection. */
const ATTEMPTS = 2;

/**
 * Resolve a map token: the build-time public token when there is one,
 * otherwise ask our own server (Vercel / Node) for a short-lived token.
 */
export async function fetchMapToken(): Promise<MapToken> {
  if (BUILD_TOKEN.startsWith('pk.')) return { token: BUILD_TOKEN, expires: null };
  let failure: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await requestServerToken();
    } catch (error) {
      failure = error;
      // The server answered and said no: asking again will not change its mind.
      if (error instanceof TokenRefused) break;
    }
  }
  throw failure;
}

class TokenRefused extends Error {}

async function requestServerToken(): Promise<MapToken> {
  const url = new URL(CONFIG.tokenUrl, document.baseURI);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = `Map token request failed (${response.status})`;
      // 4xx and "not configured" are answers; other 5xx may be passing trouble.
      throw response.status < 500 || response.status === 503 ? new TokenRefused(message) : new Error(message);
    }
    const body = (await response.json()) as { token?: unknown; expires?: unknown };
    if (typeof body.token !== 'string' || !body.token) throw new TokenRefused('Map token response was empty');
    const expires = typeof body.expires === 'string' ? Date.parse(body.expires) : null;
    return { token: body.token, expires: Number.isFinite(expires) ? expires : null };
  } finally {
    window.clearTimeout(timer);
  }
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
