import type { StyleSpecification, ExpressionSpecification } from 'mapbox-gl/esm';

/**
 * A purpose-built night basemap on Mapbox Streets v8. Deliberately sparse:
 * land, Dhaka's rivers and wetlands, a faint road skeleton, the railway, and
 * muted place names. Everything else is left out so the metro lines carry the
 * page. One vector source keeps tile weight low.
 */

export const BASE = {
  land: '#1a2029',
  landEdge: '#1e252f',
  water: '#0b1016',
  wetland: '#161c24',
  aeroway: '#242b35',
  roadMinor: '#1f262f',
  roadMid: '#252d37',
  roadMajor: '#2c3540',
  rail: '#343d49',
  label: '#8b95a1',
  labelMinor: '#5d6874',
  waterLabel: '#3f586c',
  halo: '#1a2029',
  ink: '#0f141a',
} as const;

const name: ExpressionSpecification = ['coalesce', ['get', 'name_en'], ['get', 'name']];

export function buildBasemapStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'The Daily Star, Dhaka metro night',
    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
    sources: {
      // The tileset's TileJSON inlined: saves one request before the first tile.
      streets: {
        type: 'vector',
        tiles: ['mapbox://tiles/mapbox.mapbox-streets-v8/{z}/{x}/{y}.vector.pbf'],
        minzoom: 0,
        maxzoom: 16,
        attribution:
          '<a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">&copy; Mapbox</a> <a href="https://www.openstreetmap.org/copyright/" target="_blank" rel="noopener">&copy; OpenStreetMap</a>',
        // Keeps the Mapbox wordmark that the TileJSON would have required.
        mapbox_logo: true,
      } as StyleSpecification['sources'][string],
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': BASE.land } },
      {
        id: 'wetland',
        type: 'fill',
        source: 'streets',
        'source-layer': 'landuse_overlay',
        filter: ['match', ['get', 'class'], ['wetland', 'wetland_noveg'], true, false],
        paint: { 'fill-color': BASE.wetland, 'fill-opacity': 0.8 },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'streets',
        'source-layer': 'water',
        paint: { 'fill-color': BASE.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'streets',
        'source-layer': 'waterway',
        minzoom: 8,
        filter: ['match', ['get', 'class'], ['river', 'canal'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': BASE.water,
          'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 9, 0.6, 12, 1.6, 15, 5],
        },
      },
      {
        id: 'aeroway',
        type: 'fill',
        source: 'streets',
        'source-layer': 'aeroway',
        minzoom: 10,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': BASE.aeroway },
      },
      {
        id: 'road-minor',
        type: 'line',
        source: 'streets',
        'source-layer': 'road',
        minzoom: 13,
        filter: [
          'match',
          ['get', 'class'],
          ['street', 'street_limited', 'primary_link', 'secondary_link', 'tertiary_link', 'trunk_link', 'motorway_link'],
          true,
          false,
        ],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': BASE.roadMinor,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 13, 0.4, 16, 3],
        },
      },
      {
        id: 'road-mid',
        type: 'line',
        source: 'streets',
        'source-layer': 'road',
        minzoom: 11,
        filter: ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': BASE.roadMid,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 0.4, 14, 1.4, 16, 4],
        },
      },
      {
        id: 'road-major',
        type: 'line',
        source: 'streets',
        'source-layer': 'road',
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': BASE.roadMajor,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 0.4, 12, 1.1, 14, 2.4, 16, 6],
        },
      },
      {
        id: 'rail',
        type: 'line',
        source: 'streets',
        'source-layer': 'road',
        minzoom: 10,
        filter: ['all', ['==', ['get', 'class'], 'major_rail'], ['!=', ['get', 'structure'], 'tunnel']],
        paint: {
          'line-color': BASE.rail,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1.4],
          'line-dasharray': [2, 2],
        },
      },
      {
        id: 'water-label-line',
        type: 'symbol',
        source: 'streets',
        'source-layer': 'natural_label',
        minzoom: 10,
        filter: [
          'all',
          ['match', ['get', 'class'], ['river', 'canal', 'water', 'stream'], true, false],
          ['==', ['geometry-type'], 'LineString'],
        ],
        layout: {
          'text-field': name,
          'text-font': ['DIN Pro Italic', 'Arial Unicode MS Regular'],
          'symbol-placement': 'line',
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10.5, 14, 13],
          'text-letter-spacing': 0.08,
          'text-max-angle': 30,
        },
        paint: {
          'text-color': BASE.waterLabel,
          'text-halo-color': BASE.water,
          'text-halo-width': 1,
        },
      },
      {
        id: 'place-subdivision',
        type: 'symbol',
        source: 'streets',
        'source-layer': 'place_label',
        minzoom: 11,
        filter: [
          'all',
          ['==', ['get', 'class'], 'settlement_subdivision'],
          ['<=', ['get', 'filterrank'], 1],
          // Housing-estate blocks ("Block A", "Block H") add clutter, not orientation.
          ['!', ['in', 'Block', ['coalesce', ['get', 'name_en'], ['get', 'name'], '']]],
        ],
        layout: {
          'text-field': name,
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.14,
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9.5, 15, 12],
          'text-max-width': 7,
          'symbol-sort-key': ['get', 'symbolrank'],
        },
        paint: {
          'text-color': BASE.labelMinor,
          'text-halo-color': BASE.halo,
          'text-halo-width': 1.2,
        },
      },
      {
        id: 'place-settlement',
        type: 'symbol',
        source: 'streets',
        'source-layer': 'place_label',
        maxzoom: 14,
        filter: [
          'all',
          ['==', ['get', 'class'], 'settlement'],
          ['match', ['get', 'type'], ['city', 'town'], true, false],
        ],
        layout: {
          'text-field': name,
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.22,
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 12, 13.5],
          'symbol-sort-key': ['get', 'symbolrank'],
        },
        paint: {
          'text-color': BASE.label,
          'text-halo-color': BASE.halo,
          'text-halo-width': 1.4,
        },
      },
    ],
  };
}
