/**
 * Vercel adapter for /api/mapbox-token (Edge runtime).
 * Set MAPBOX_SECRET_TOKEN (and optionally MAPBOX_USERNAME, ALLOWED_ORIGINS)
 * in Project Settings > Environment Variables.
 */
import { handleMapboxToken } from '../server/mapbox-token.mjs';

export const config = { runtime: 'edge' };

export default function handler(request) {
  return handleMapboxToken(request, process.env);
}
