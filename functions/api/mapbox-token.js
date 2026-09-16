/**
 * Cloudflare Pages Functions adapter for /api/mapbox-token.
 * Set MAPBOX_SECRET_TOKEN (and optionally MAPBOX_USERNAME, ALLOWED_ORIGINS)
 * as encrypted variables in the Pages project settings.
 */
import { handleMapboxToken } from '../../server/mapbox-token.mjs';

export function onRequest({ request, env }) {
  return handleMapboxToken(request, env);
}
