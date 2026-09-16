/**
 * Response headers for the published story. Shared by the Node server; the
 * same policy is mirrored in vercel.json and public/_headers.
 *
 * connect-src lists only Mapbox: the page talks to nothing else.
 * worker-src/child-src allow blob: because mapbox-gl may spawn workers from blobs.
 * style-src needs 'unsafe-inline' for the inline custom properties that set line colours.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://api.mapbox.com https://events.mapbox.com",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://*.thedailystar.net",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
