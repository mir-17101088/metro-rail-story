/**
 * GET /api/mapbox-token
 *
 * Hands the browser a Mapbox access token without ever shipping the account's
 * long-lived token in the page source or the JavaScript bundle.
 *
 * Production (recommended): set MAPBOX_SECRET_TOKEN, a secret token (sk.*)
 * with the `tokens:write` scope. The endpoint mints a *temporary* token
 * (tk.*) through the Mapbox Tokens API, valid for at most one hour, caches it,
 * and serves the same short-lived token to every reader until shortly before
 * it expires. Anything scraped from a browser stops working within the hour.
 *
 * Fallback: set MAPBOX_PUBLIC_TOKEN to a URL-restricted public token (pk.*).
 * Useful for local development; in production only use a token restricted to
 * your domain in the Mapbox account dashboard.
 *
 * Written against Web standard Request/Response so the same code runs in Node
 * (server/node-server.mjs, Vite dev server), Vercel and Cloudflare.
 */

const MAPBOX_API = 'https://api.mapbox.com';
const TEMP_TOKEN_LIFETIME_MS = 55 * 60 * 1000; // Mapbox allows up to 60 minutes
const REISSUE_MARGIN_MS = 10 * 60 * 1000; // hand out a fresh token well before expiry
const DEFAULT_SCOPES = ['styles:read', 'styles:tiles', 'fonts:read'];

let cached = null; // { token, expiresAt }
let pending = null;

export async function handleMapboxToken(request, env = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
  }
  if (!isAllowedCaller(request, env)) {
    return json(403, { error: 'Forbidden' });
  }

  const secret = clean(env.MAPBOX_SECRET_TOKEN);
  if (secret) {
    try {
      const { token, expiresAt } = await temporaryToken(secret, env);
      return json(200, { token, expires: new Date(expiresAt).toISOString() });
    } catch (error) {
      console.error(`[mapbox-token] ${error.message}`);
      return json(502, { error: 'Could not issue a map token' });
    }
  }

  const publicToken = clean(env.MAPBOX_PUBLIC_TOKEN);
  if (publicToken) {
    if (!publicToken.startsWith('pk.')) {
      console.error('[mapbox-token] MAPBOX_PUBLIC_TOKEN must be a public (pk.*) token');
      return json(500, { error: 'Map token is misconfigured' });
    }
    return json(200, { token: publicToken, expires: null });
  }

  return json(503, { error: 'Map token is not configured' });
}

async function temporaryToken(secret, env) {
  const now = Date.now();
  if (cached && cached.expiresAt - REISSUE_MARGIN_MS > now) return cached;
  if (pending) return pending;

  pending = (async () => {
    if (!secret.startsWith('sk.')) throw new Error('MAPBOX_SECRET_TOKEN must be a secret (sk.*) token');
    const username = clean(env.MAPBOX_USERNAME) || usernameFromToken(secret);
    if (!username) throw new Error('Set MAPBOX_USERNAME; it could not be read from the token');

    const scopes = clean(env.MAPBOX_TEMP_TOKEN_SCOPES)
      ? env.MAPBOX_TEMP_TOKEN_SCOPES.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_SCOPES;

    const response = await fetch(
      `${MAPBOX_API}/tokens/v2/${encodeURIComponent(username)}?access_token=${encodeURIComponent(secret)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires: new Date(now + TEMP_TOKEN_LIFETIME_MS).toISOString(), scopes }),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Mapbox Tokens API responded ${response.status} ${detail.slice(0, 200)}`);
    }
    const body = await response.json();
    if (typeof body.token !== 'string') throw new Error('Mapbox Tokens API returned no token');
    const expiresAt = Date.parse(body.expires) || now + TEMP_TOKEN_LIFETIME_MS;
    cached = { token: body.token, expiresAt };
    return cached;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/**
 * Browsers mark same-origin fetches with Sec-Fetch-Site. Cross-origin callers
 * must be listed in ALLOWED_ORIGINS (comma separated). This keeps other sites
 * from casually hot-linking the endpoint; it is not a substitute for the short
 * token lifetime, which is the real protection.
 */
function isAllowedCaller(request, env) {
  if (clean(env.ALLOW_ANY_ORIGIN) === 'true') return true;

  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const site = request.headers.get('sec-fetch-site');
  if (site === 'same-origin') return true;

  const origin = request.headers.get('origin') || originOf(request.headers.get('referer'));
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function usernameFromToken(token) {
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64)).u || '';
  } catch {
    return '';
  }
}

function originOf(url) {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}
