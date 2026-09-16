import type { Map as MapboxMap, LngLatBoundsLike, PaddingOptions } from 'mapbox-gl/esm';
import { featureById, stationById, type FeatureId, type LngLat } from '../data/network';
import { CONFIG } from '../config';
import { easeInOut, prefersReducedMotion } from '../lib/motion';

export function boundsOf(features: FeatureId[], stations: string[] = []): LngLatBoundsLike {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = ([x, y]: LngLat) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const f of features) featureById.get(f)?.geometry.coordinates.forEach(add);
  for (const s of stations) {
    const st = stationById.get(s);
    if (st) add(st.geometry.coordinates);
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

const isWide = () => window.matchMedia('(min-width: 1024px)').matches;

/**
 * Keep the network clear of whatever sits on top of the map: the reading
 * column on wide screens, the masthead, the docked explorer on phones, and
 * the part of a 100lvh stage hidden behind mobile browser toolbars.
 */
export function paddingFor(stage: HTMLElement, stepId: string): PaddingOptions {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const hiddenBottom = Math.max(0, h - window.innerHeight);
  const masthead = 72;

  if (stepId === 'hero') {
    const side = Math.round(w * (isWide() ? 0.16 : 0.08));
    return { top: masthead + 24, bottom: hiddenBottom + 48, left: side, right: side };
  }

  if (isWide()) {
    if (stepId === 'network') {
      const dock = document.querySelector<HTMLElement>('.network');
      // Collapsed: only the slim reopen tab is left on screen.
      if (!dock || dock.hasAttribute('data-collapsed')) {
        return { top: masthead + 24, bottom: 56, left: 88, right: 64 };
      }
      // Layout box, not getBoundingClientRect: the dock may be mid-slide.
      const right = dock.offsetLeft + dock.offsetWidth;
      return { top: masthead + 24, bottom: 56, left: Math.min(w * 0.55, right + 48), right: 64 };
    }
    const column = document.querySelector<HTMLElement>('.step:not(.step--hero) .card');
    const right = column ? column.getBoundingClientRect().right : w * 0.4;
    return { top: masthead + 24, bottom: 56, left: Math.min(w * 0.55, right + 48), right: 64 };
  }

  // Cards arrive from the bottom on phones, so frame the map a little higher.
  let bottom = hiddenBottom + Math.round(h * 0.22);
  if (stepId === 'network') {
    const panel = document.querySelector<HTMLElement>('.network');
    // While the tray animates open or closed, frame for the size it is heading to.
    const settled = Number(panel?.dataset.settledHeight);
    if (panel) bottom = hiddenBottom + (settled > 0 ? settled : panel.offsetHeight) + 24;
  }
  // Side room so terminus labels and line badges are not cut off.
  return { top: masthead + 16, bottom: Math.min(bottom, h * 0.6), left: 44, right: 44 };
}

export function frame(
  map: MapboxMap,
  bounds: LngLatBoundsLike,
  padding: PaddingOptions,
  {
    maxZoom = 13.2,
    instant = false,
    pace = 'story',
  }: {
    maxZoom?: number;
    instant?: boolean;
    /** 'story' for cinematic scene changes, 'ui' for snappier moves the reader asked for. */
    pace?: 'story' | 'ui';
  } = {},
): void {
  const camera = map.cameraForBounds(bounds, { padding, maxZoom });
  if (!camera) return;
  // mapbox-gl v3 returns the plain centre of the bounds; the padding has to
  // travel with the camera move to shift that centre into the clear area.
  const { center, zoom } = camera;
  if (instant || prefersReducedMotion()) {
    map.jumpTo({ center, zoom, padding });
    return;
  }
  const dz = Math.abs((zoom ?? map.getZoom()) - map.getZoom());
  const duration =
    pace === 'ui'
      ? Math.min(1500, 720 + dz * 240)
      : Math.min(2600, CONFIG.cameraDuration * 0.6 + dz * 380);
  map.flyTo({
    center,
    zoom,
    padding,
    duration,
    // A flatter arc for reader-driven moves: less zoom-out-then-in bounce.
    curve: pace === 'ui' ? 1.15 : 1.3,
    easing: easeInOut,
    essential: false,
  });
}
