import type { Map as MapboxMap, ExpressionSpecification } from 'mapbox-gl/esm';
import { network, ALL_FEATURES, type FeatureId } from '../data/network';
import { LINES, LINE_ORDER, type LineId } from '../data/lines';
import { BASE } from './basemap';

export const SRC = {
  lines: 'net-lines',
  underground: 'net-underground',
  stations: 'net-stations',
  badges: 'net-badges',
} as const;

export const LAYER = {
  line: (id: FeatureId) => `line-${id}`,
  core: (index: number) => `underground-core-${index}`,
  /** Bolder hollow tube, faded in when a step spotlights the underground sections. */
  tube: (index: number) => `underground-tube-${index}`,
  tubeCore: (index: number) => `underground-tube-core-${index}`,
  hit: 'lines-hit',
  stations: 'stations',
  selected: 'station-selected',
  labels: 'station-labels',
  labelsMinor: 'station-labels-minor',
  badges: 'line-badges',
} as const;

/** Bottom-to-top: Line 6 is drawn last so the one line in service sits on top. */
const PAINT_ORDER: FeatureId[] = [
  '2-branch',
  '2-trunk',
  '4-trunk',
  '5S-trunk',
  '5N-trunk',
  '1-branch',
  '1-trunk',
  '6-extension',
  '6-operational',
];

export const LINE_WIDTH: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  2,
  10,
  2.7,
  11,
  3.3,
  12.5,
  4.3,
  14,
  6,
  16,
  9,
];

/** Dark core of an underground (hollow) line, about 40% of the line width. */
const CORE_WIDTH: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  0.75,
  10,
  1.05,
  11,
  1.35,
  12.5,
  1.75,
  14,
  2.5,
  16,
  3.7,
];

/** Spotlight tube: roughly 1.9x the line, with a proportionally wider core. */
const TUBE_WIDTH: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  3.8,
  10,
  5,
  11,
  6.2,
  12.5,
  8,
  14,
  11,
  16,
  16,
];

const TUBE_CORE_WIDTH: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.4],
  ['zoom'],
  9,
  1.6,
  10,
  2.1,
  11,
  2.6,
  12.5,
  3.4,
  14,
  4.7,
  16,
  6.8,
];

export const LINE_OPACITY_TRANSITION = { duration: 450, delay: 0 };

const colorOfLine: ExpressionSpecification = [
  'match',
  ['get', 'primary'],
  ...LINE_ORDER.flatMap((l) => [l, LINES[l].color]),
  '#ffffff',
] as unknown as ExpressionSpecification;

export const shown: ExpressionSpecification = ['boolean', ['feature-state', 'shown'], false];
/** True once two or more of a station's lines are drawn through it. */
export const activeInterchange: ExpressionSpecification = ['boolean', ['feature-state', 'ix'], false];

const byKind = (interchange: number, station: number): ExpressionSpecification => [
  'case',
  activeInterchange,
  interchange,
  station,
];

/**
 * Opacity for station marks: hidden until revealed, dimmed when their lines are
 * out of focus. With `undergroundOnly`, elevated stations on the focused lines
 * also step back so the subterranean ones carry the frame.
 */
export function stationOpacity(focus: LineId[] | null, dim: number, undergroundOnly = false): ExpressionSpecification {
  const inFocus: ExpressionSpecification = focus
    ? (['any', ...focus.map((l) => ['get', `has_${l}`])] as unknown as ExpressionSpecification)
    : ['literal', true];
  const focused = (
    undergroundOnly
      ? ['case', ['any', activeInterchange, ['match', ['get', 'depth'], ['underground', 'mixed'], true, false]], 1, 0.5]
      : 1
  ) as ExpressionSpecification;
  return ['case', shown, ['case', inFocus, focused, dim], 0];
}

/**
 * Station fill. Interchanges: white. Other stations: hollow by default; once
 * the underground/elevated encoding is on, elevated stations fill with their
 * line colour, matching solid (elevated) and hollow (underground) lines.
 */
export function stationFill(depth: boolean): ExpressionSpecification {
  const regular = depth
    ? (['match', ['get', 'depth'], 'elevated', colorOfLine, BASE.ink] as unknown as ExpressionSpecification)
    : BASE.ink;
  return ['case', activeInterchange, '#f1f3f5', regular] as unknown as ExpressionSpecification;
}

function makeBadge(color: string, wide: boolean): ImageData {
  const ratio = 2;
  const h = 22 * ratio;
  const w = (wide ? 30 : 22) * ratio;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const r = h / 2;
  ctx.fillStyle = BASE.ink;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, r);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(2 * ratio, 2 * ratio, w - 4 * ratio, h - 4 * ratio, r - 2 * ratio);
  ctx.fill();
  return ctx.getImageData(0, 0, w, h);
}

export function addNetworkLayers(map: MapboxMap): void {
  map.addSource(SRC.lines, { type: 'geojson', data: network.lines as never, lineMetrics: true });
  map.addSource(SRC.underground, { type: 'geojson', data: network.underground as never, lineMetrics: true });
  map.addSource(SRC.stations, { type: 'geojson', data: network.stations as never });
  map.addSource(SRC.badges, { type: 'geojson', data: network.badges as never });

  for (const l of LINE_ORDER) {
    map.addImage(`badge-${l}`, makeBadge(LINES[l].color, l.length > 1), { pixelRatio: 2 });
  }

  for (const id of PAINT_ORDER) {
    const line = network.lines.features.find((f) => f.properties.id === id)!.properties.line;
    map.addLayer({
      id: LAYER.line(id),
      type: 'line',
      source: SRC.lines,
      filter: ['==', ['get', 'id'], id],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        visibility: 'none',
      },
      paint: {
        'line-color': LINES[line].color,
        'line-width': LINE_WIDTH,
        'line-opacity': 1,
        'line-opacity-transition': LINE_OPACITY_TRANSITION,
        'line-trim-offset': [0, 1],
      },
    });

    // Underground sections sit directly above their own line so a hollow
    // core never paints over a different line at a crossing.
    network.underground.features.forEach((u, index) => {
      if (u.properties.feature !== id) return;
      map.addLayer({
        id: LAYER.tube(index),
        type: 'line',
        source: SRC.underground,
        filter: ['==', ['get', 'feature'], id],
        layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
        paint: {
          'line-color': LINES[line].color,
          'line-width': TUBE_WIDTH,
          'line-opacity': 0,
          'line-opacity-transition': LINE_OPACITY_TRANSITION,
          'line-trim-offset': [0, 1],
        },
      });
      map.addLayer({
        id: LAYER.tubeCore(index),
        type: 'line',
        source: SRC.underground,
        filter: ['==', ['get', 'feature'], id],
        layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
        paint: {
          'line-color': BASE.land,
          'line-width': TUBE_CORE_WIDTH,
          'line-opacity': 0,
          'line-opacity-transition': LINE_OPACITY_TRANSITION,
          'line-trim-offset': [0, 1],
        },
      });
      map.addLayer({
        id: LAYER.core(index),
        type: 'line',
        source: SRC.underground,
        filter: ['==', ['get', 'feature'], id],
        layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
        paint: {
          'line-color': BASE.land,
          'line-width': CORE_WIDTH,
          'line-opacity': 0,
          'line-opacity-transition': LINE_OPACITY_TRANSITION,
          'line-trim-offset': [0, 1],
        },
      });
    });
  }

  map.addLayer({
    id: LAYER.hit,
    type: 'line',
    source: SRC.lines,
    filter: ['in', ['get', 'id'], ['literal', []]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 18 },
  });

  map.addLayer({
    id: LAYER.stations,
    type: 'circle',
    source: SRC.stations,
    layout: { 'circle-sort-key': ['case', ['get', 'interchange'], 1, 0] },
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        byKind(2.4, 1.3),
        11,
        byKind(3.6, 2.2),
        12.5,
        byKind(5, 3.1),
        14,
        byKind(9, 4.6),
        15,
        byKind(12, 5.5),
        16,
        byKind(15, 6.5),
      ],
      'circle-color': stationFill(false),
      'circle-stroke-color': ['case', activeInterchange, BASE.ink, colorOfLine],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, byKind(0.8, 0.7), 12, byKind(1.5, 1.3), 14, byKind(2.2, 2)],
      'circle-opacity': stationOpacity(null, 1),
      'circle-stroke-opacity': stationOpacity(null, 1),
      'circle-pitch-alignment': 'map',
    },
  });

  map.addLayer({
    id: LAYER.selected,
    type: 'circle',
    source: SRC.stations,
    filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 6, 12, 9, 14, 15, 16, 20],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#f1f3f5',
      'circle-stroke-width': 2,
    },
  });

  const labelLayout = {
    'text-field': ['get', 'name'],
    'text-font': [
      'case',
      ['get', 'interchange'],
      ['literal', ['DIN Pro Bold', 'Arial Unicode MS Bold']],
      ['literal', ['DIN Pro Medium', 'Arial Unicode MS Regular']],
    ],
    'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10.5, 13, 12.5, 16, 14.5],
    'text-variable-anchor': ['left', 'right', 'top', 'bottom', 'top-left', 'bottom-right'],
    'text-radial-offset': ['case', ['get', 'interchange'], 1.05, 0.75],
    'text-justify': 'auto',
    'text-max-width': 8,
    'symbol-sort-key': ['case', ['get', 'interchange'], 0, ['get', 'terminus'], 1, 2],
    'text-padding': 3,
  } as const;

  const labelPaint = {
    'text-color': '#dde2e7',
    'text-halo-color': BASE.land,
    'text-halo-width': 1.4,
    'text-halo-blur': 0.3,
    'text-opacity': ['case', shown, 1, 0],
  } as const;

  map.addLayer({
    id: LAYER.labelsMinor,
    type: 'symbol',
    source: SRC.stations,
    minzoom: 12.6,
    filter: ['in', ['get', 'id'], ['literal', []]],
    layout: labelLayout as never,
    paint: labelPaint as never,
  });

  map.addLayer({
    id: LAYER.labels,
    type: 'symbol',
    source: SRC.stations,
    filter: ['in', ['get', 'id'], ['literal', []]],
    layout: labelLayout as never,
    paint: labelPaint as never,
  });

  map.addLayer({
    id: LAYER.badges,
    type: 'symbol',
    source: SRC.badges,
    filter: ['in', ['get', 'line'], ['literal', []]],
    layout: {
      'icon-image': ['concat', 'badge-', ['get', 'line']],
      'icon-allow-overlap': true,
      'text-field': ['get', 'line'],
      'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
      'text-size': 11,
      'text-allow-overlap': true,
      'text-offset': [0, 0.05],
    },
    paint: {
      'text-color': BASE.ink,
      'icon-opacity': 1,
      'text-opacity': 1,
    },
  });
}

export { ALL_FEATURES };
