/**
 * Editorial switches. Safe to change without touching the map code.
 */
export const CONFIG = {
  /**
   * Camera moves (zoom in to Kamlapur, pull back for new lines).
   * Per the brief: switch to false if Lighthouse drops below 90 or tiles load
   * slowly; every step then shares one fixed view of the whole network.
   */
  cameraMotion: true,

  /** Trains running on the operational section of Line 6. */
  trains: true,

  /** Where the page requests a short-lived Mapbox token, relative to the page. */
  tokenUrl: (import.meta.env.VITE_MAPBOX_TOKEN_URL as string | undefined) || 'api/mapbox-token',

  /** Camera flight duration in ms. */
  cameraDuration: 2000,
};
