/**
 * Build step: KML (hand-drawn in Google Earth) -> render-ready GeoJSON.
 *
 *   node scripts/build-network.mjs
 *
 * What it does, in order:
 *  1. Parses every LineString and Point in data/source/mrt-network.kml.
 *  2. Orients each line in reading order (the way the story describes it).
 *  3. Works out which lines serve each station (name tags + proximity), so
 *     interchanges such as Kamlapur, Karwan Bazar or Gabtoli become ONE shared
 *     station rather than several dots stacked on top of each other.
 *  4. Snaps every line so it passes exactly through its stations. Hand-drawn
 *     lines stop 30-80 m short of Kamlapur; without this they look disconnected.
 *  5. Finds corridors where two different lines run along the same alignment
 *     (Motijheel-Kamlapur, Gabtoli-Technical, Signboard) and eases them apart
 *     into parallel tracks so neither colour hides the other.
 *  6. Derives underground sections, line badges and the Line 6 train path.
 *
 * Output: src/data/network.json (committed, imported by the map chunk).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { kml } from '@tmcw/togeojson';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'data/source/mrt-network.kml');
const OUT = resolve(ROOT, 'src/data/network.json');

// The output is committed, so a build can go ahead without the KML (a hosted
// build from an upload that left data/ out, say). It only regenerates when the
// source is there.
if (!existsSync(SRC)) {
  if (existsSync(OUT)) {
    console.warn('[data] data/source/mrt-network.kml not found: using the committed src/data/network.json unchanged.');
    process.exit(0);
  }
  console.error('[data] data/source/mrt-network.kml not found, and there is no src/data/network.json to fall back on.');
  process.exit(1);
}

/* ------------------------------------------------------------------ config */

const DENSIFY_M = 12; // working vertex spacing
const SNAP_WINDOW_M = 220; // how far along the line a snap is eased out
const MEMBER_RADIUS_M = 100; // station counts as "on" a line within this distance
const CORRIDOR_NEAR_M = 70; // two lines closer than this may share a corridor
const CORRIDOR_MIN_RUN_M = 180; // ...if they stay close (and parallel) this long
const CORRIDOR_TAPER_M = 160; // ease in/out of the parallel offset
const TRACK_GAP_M = 52; // centre-to-centre spacing of parallel tracks
const SIMPLIFY_M = 0.8;

/** KML LineString name -> line id, part, and whether to reverse to reading order */
const LINE_FEATURES = {
  'MRT6 line': { line: '6', part: 'trunk', reverse: true }, // Uttara North -> Kamlapur
  'MRT1(UnderGround)': { line: '1', part: 'trunk', reverse: false }, // Kamlapur -> Airport
  'MRT1(Elevated)': { line: '1', part: 'branch', reverse: false }, // Notun Bazar -> Purbachal
  'MRT-5N': { line: '5N', part: 'trunk', reverse: true }, // Hemayetpur -> Vatara
  'MRT-5S': { line: '5S', part: 'trunk', reverse: true }, // Gabtoli -> Dasherkandi
  'MRT-2 (Main Line)': { line: '2', part: 'trunk', reverse: true }, // Gabtoli -> Narayanganj
  'MRT-2(Branch Line)': { line: '2', part: 'branch', reverse: true }, // Gulistan -> Sadarghat
  'MRT-4': { line: '4', part: 'trunk', reverse: true }, // Kamlapur -> Madanpur
};

const LINE_ORDER = ['6', '1', '5N', '5S', '2', '4'];

/**
 * Station depth per line, from "MRT routes and stations names.docx".
 * Names are the KML spellings (the KML wins where the two documents differ).
 * Mostul is tagged "(Underground)" in the KML but sits on the elevated
 * Purbachal alignment and is listed as elevated in the route document.
 */
const DEPTH = {
  6: { default: 'elevated' },
  1: {
    underground: [
      'Kamlapur', 'Rajarbagh', 'Malibagh', 'Rampura', 'Aftabnagar', 'Badda', 'North Badda',
      'Notun Bazar', 'Nadda', 'Khilkhet', 'Airport Terminal 3', 'Airport',
    ],
    elevated: [
      'Joar Sahara', 'Boalia', 'Mostul', 'Purbachal Cricket Stadium', 'Purbachal Center',
      'Purbachal East', 'Purbachal Terminal',
    ],
  },
  '5N': {
    underground: [
      'Gabtoli', 'Dar-us-Salam', 'Mirpur 1', 'Mirpur 10', 'Mirpur 14', 'Kochukhet', 'Banani',
      'Gulshan 2', 'Notun Bazar',
    ],
    elevated: ['Hemayetpur', 'Baliarpur', 'Bilamia', 'Amin Bazar', 'Vatara'],
  },
  '5S': {
    underground: [
      'Gabtoli', 'Technical', 'Kallyanpur', 'Shyamoli', 'College Gate', 'Asad Gate',
      'Russel Square', 'Karwan Bazar', 'Hatirjheel', 'Tejgaon', 'Aftabnagar',
    ],
    elevated: ['Aftabnagar Central', 'Aftabnagar East', 'Nasirabad', 'Dasherkandi'],
  },
  2: { default: 'unspecified' },
  4: { default: 'unspecified' },
};

/**
 * Underground stretches, expressed as station pairs: the portal is placed
 * halfway between the last station of one kind and the first of the other.
 * `null` means the section runs to the end of the feature.
 */
const UNDERGROUND = [
  { line: '1', part: 'trunk', from: null, to: null },
  { line: '5N', part: 'trunk', from: ['Amin Bazar', 'Gabtoli'], to: ['Notun Bazar', 'Vatara'] },
  { line: '5S', part: 'trunk', from: null, to: ['Aftabnagar', 'Aftabnagar Central'] },
];

/** Where each line's bullet badge sits: its least crowded terminus. */
const BADGES = [
  { line: '6', station: 'Uttara North' },
  { line: '1', station: 'Airport' },
  { line: '1', station: 'Purbachal Terminal' },
  { line: '5N', station: 'Hemayetpur' },
  { line: '5N', station: 'Vatara' },
  { line: '5S', station: 'Dasherkandi' },
  { line: '2', station: 'Narayanganj' },
  { line: '4', station: 'Madanpur' },
];

/* ---------------------------------------------------------------- geometry */

const R = 6371008.8;
const LAT0 = 23.75;
const KX = (Math.PI / 180) * R * Math.cos((LAT0 * Math.PI) / 180);
const KY = (Math.PI / 180) * R;
const toXY = ([lng, lat]) => [lng * KX, lat * KY];
const toLL = ([x, y]) => [+(x / KX).toFixed(6), +(y / KY).toFixed(6)];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(len(sub(b, a)) / step));
    for (let k = 1; k <= n; k++) out.push(add(a, mul(sub(b, a), k / n)));
  }
  return out;
}

function cumulative(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + len(sub(pts[i], pts[i - 1])));
  return c;
}

/** Nearest point on a polyline: segment index, t, point, distance, distance along. */
function nearest(p, pts, cum = cumulative(pts)) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const ab = sub(pts[i + 1], a);
    const L2 = dot(ab, ab);
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2));
    const q = add(a, mul(ab, t));
    const d = len(sub(p, q));
    if (!best || d < best.d) best = { i, t, q, d, along: cum[i] + t * Math.sqrt(L2) };
  }
  return best;
}

function tangentAt(pts, i) {
  const a = pts[Math.max(0, i - 2)];
  const b = pts[Math.min(pts.length - 1, i + 2)];
  return norm(sub(b, a));
}

/** Point at a given distance along the polyline. */
function pointAlong(pts, cum, d) {
  if (d <= 0) return { p: pts[0], i: 0 };
  const total = cum[cum.length - 1];
  if (d >= total) return { p: pts[pts.length - 1], i: pts.length - 2 };
  let i = 1;
  while (cum[i] < d) i++;
  const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
  return { p: add(pts[i - 1], mul(sub(pts[i], pts[i - 1]), t)), i: i - 1 };
}

/** Slice of a polyline between two along-distances. */
function slice(pts, cum, from, to) {
  const a = pointAlong(pts, cum, from);
  const b = pointAlong(pts, cum, to);
  const out = [a.p];
  for (let i = a.i + 1; i <= b.i; i++) out.push(pts[i]);
  out.push(b.p);
  return out;
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const ab = sub(pts[e], pts[s]);
    const L = len(ab) || 1;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(cross(ab, sub(pts[i], pts[s]))) / L;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/* ------------------------------------------------------------------- parse */

const doc = new DOMParser().parseFromString(readFileSync(SRC, 'utf8'), 'text/xml');
const gj = kml(doc);

const features = [];
const stationsRaw = [];

for (const f of gj.features) {
  const name = (f.properties?.name ?? '').trim();
  if (f.geometry?.type === 'LineString') {
    const cfg = LINE_FEATURES[name];
    if (!cfg) throw new Error(`Unmapped KML line: "${name}"`);
    let coords = f.geometry.coordinates.map(([x, y]) => [x, y]);
    if (cfg.reverse) coords = coords.reverse();
    features.push({ ...cfg, kmlName: name, pts: densify(coords.map(toXY), DENSIFY_M) });
  } else if (f.geometry?.type === 'Point') {
    stationsRaw.push({ kmlName: name, xy: toXY(f.geometry.coordinates) });
  }
}

function parseStation(raw) {
  const tags = new Set();
  for (const m of raw.matchAll(/MRT[\s-]?(\d)\s*([NS])?/gi)) tags.add(m[1] + (m[2] ?? '').toUpperCase());
  const name = raw
    .replace(/\s*Metro Station.*$/i, '')
    .replace(/\s*MRT.*$/i, '')
    .trim();
  return { name, tags: [...tags] };
}

const stations = stationsRaw.map((s) => {
  const { name, tags } = parseStation(s.kmlName);
  return { id: slug(name), name, kmlName: s.kmlName, tags, xy: s.xy, lines: new Set(tags) };
});

/* ------------------------------------------------------ station membership */

for (const s of stations) {
  for (const f of features) {
    const n = nearest(s.xy, f.pts);
    if (n.d <= MEMBER_RADIUS_M) s.lines.add(f.line);
  }
  // A tag with no nearby geometry is a data problem worth hearing about.
  for (const t of s.tags) {
    const onLine = features.some((f) => f.line === t && nearest(s.xy, f.pts).d <= 400);
    if (!onLine) console.warn(`! ${s.name}: tagged ${t} but no ${t} geometry within 400 m`);
  }
}

/* ------------------------------------------------------------------ snapping */

function snap(feature, target) {
  const pts = feature.pts;
  const cum = cumulative(pts);
  const n = nearest(target, pts, cum);
  if (n.d < 0.05) return 0;
  // Make the projection an actual vertex.
  let k;
  if (n.t <= 1e-6) k = n.i;
  else if (n.t >= 1 - 1e-6) k = n.i + 1;
  else {
    pts.splice(n.i + 1, 0, n.q);
    k = n.i + 1;
  }
  const c = cumulative(pts);
  const delta = sub(target, pts[k]);
  for (let j = 0; j < pts.length; j++) {
    const dj = Math.abs(c[j] - c[k]);
    if (dj >= SNAP_WINDOW_M) continue;
    const w = 0.5 * (1 + Math.cos((Math.PI * dj) / SNAP_WINDOW_M));
    pts[j] = add(pts[j], mul(delta, w));
  }
  return n.d;
}

for (const s of stations) {
  for (const f of features) {
    if (!s.lines.has(f.line)) continue;
    // Only snap to the feature(s) of that line that actually come near.
    if (nearest(s.xy, f.pts).d > MEMBER_RADIUS_M) continue;
    const moved = snap(f, s.xy);
    if (moved > 25) console.log(`  snapped ${f.kmlName} to ${s.name}: ${moved.toFixed(0)} m`);
  }
}

/* --------------------------------------------------------- shared corridors */

/** For feature A, which vertices run alongside feature B (close AND parallel), grouped in runs. */
function corridorRuns(A, B) {
  const cumA = cumulative(A.pts);
  const cumB = cumulative(B.pts);
  const flags = A.pts.map((p, i) => {
    const n = nearest(p, B.pts, cumB);
    if (n.d > CORRIDOR_NEAR_M) return null;
    const ta = tangentAt(A.pts, i);
    const tb = tangentAt(B.pts, n.i);
    if (Math.abs(dot(ta, tb)) < 0.85) return null; // a crossing, not a corridor
    return n;
  });
  const runs = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const lengthM = cumA[i - 1] - cumA[start];
      if (lengthM >= CORRIDOR_MIN_RUN_M) runs.push({ start, end: i - 1, lengthM });
      start = -1;
    }
  }
  return { runs, cumA };
}

/** Smooth 0..1 membership weight along A for a set of runs. */
function runWeights(cumA, runs) {
  return cumA.map((d) => {
    let w = 0;
    for (const r of runs) {
      const a = cumA[r.start];
      const b = cumA[r.end];
      let v;
      if (d >= a && d <= b) v = 1;
      else {
        const gap = d < a ? a - d : d - b;
        v = gap >= CORRIDOR_TAPER_M ? 0 : 0.5 * (1 + Math.cos((Math.PI * gap) / CORRIDOR_TAPER_M));
      }
      w = Math.max(w, v);
    }
    return w;
  });
}

const displacement = features.map((f) => f.pts.map(() => ({ attract: [0, 0], wsum: 0, push: [0, 0] })));

for (let ai = 0; ai < features.length; ai++) {
  for (let bi = ai + 1; bi < features.length; bi++) {
    const A = features[ai];
    const B = features[bi];
    if (A.line === B.line) continue; // a line's own branch may share track

    const ra = corridorRuns(A, B);
    const rb = corridorRuns(B, A);
    if (!ra.runs.length || !rb.runs.length) continue;

    // Which side of A does B sit on? Decide once per pair, including the
    // stretch where they diverge, so the offset never flips mid-corridor.
    let sideSum = 0;
    const wA = runWeights(ra.cumA, ra.runs.map((r) => ({ ...r })));
    const cumB = cumulative(B.pts);
    A.pts.forEach((p, i) => {
      if (wA[i] === 0 && !ra.runs.some((r) => i >= r.start - 60 && i <= r.end + 60)) return;
      const n = nearest(p, B.pts, cumB);
      if (n.d > CORRIDOR_NEAR_M * 4) return;
      sideSum += cross(tangentAt(A.pts, i), sub(n.q, p)) * (1 / (1 + n.d / 50));
    });
    const bOnLeftOfA = sideSum >= 0;

    console.log(
      `  corridor ${A.kmlName} ~ ${B.kmlName}: ${ra.runs.map((r) => r.lengthM.toFixed(0) + ' m').join(', ')} ` +
        `(${B.line} on ${bOnLeftOfA ? 'left' : 'right'} of ${A.line})`,
    );

    // Push A away from B, and B away from A, around their shared midline.
    const cumA = ra.cumA;
    const pushA = A.pts.map((_, i) => {
      const t = tangentAt(A.pts, i);
      const left = [-t[1], t[0]];
      return bOnLeftOfA ? mul(left, -1) : left;
    });
    A.pts.forEach((p, i) => {
      const w = wA[i];
      if (!w) return;
      const n = nearest(p, B.pts, cumB);
      const acc = displacement[ai][i];
      acc.attract = add(acc.attract, mul(sub(n.q, p), 0.5 * w));
      acc.wsum += w;
      acc.push = add(acc.push, mul(pushA[i], (TRACK_GAP_M / 2) * w));
    });

    const wB = runWeights(rb.cumA, rb.runs);
    B.pts.forEach((p, i) => {
      const w = wB[i];
      if (!w) return;
      const n = nearest(p, A.pts, cumA);
      const k = Math.min(A.pts.length - 1, n.t < 0.5 ? n.i : n.i + 1);
      const acc = displacement[bi][i];
      acc.attract = add(acc.attract, mul(sub(n.q, p), 0.5 * w));
      acc.wsum += w;
      acc.push = add(acc.push, mul(pushA[k], -(TRACK_GAP_M / 2) * w));
    });
  }
}

features.forEach((f, fi) => {
  f.pts = f.pts.map((p, i) => {
    const d = displacement[fi][i];
    if (!d.wsum) return p;
    return add(add(p, mul(d.attract, 1 / Math.max(1, d.wsum))), d.push);
  });
});

/* -------------------------------------- stations back onto offset tracks */

for (const s of stations) {
  s.lines = [...s.lines].sort((a, b) => LINE_ORDER.indexOf(a) - LINE_ORDER.indexOf(b));
  s.interchange = s.lines.length > 1;
  if (!s.interchange) {
    // Single-line stations sit exactly on their (possibly offset) track.
    const f = features
      .filter((x) => x.line === s.lines[0])
      .map((x) => ({ x, n: nearest(s.xy, x.pts) }))
      .sort((a, b) => a.n.d - b.n.d)[0];
    if (f) s.xy = f.n.q;
  }
}

/* ----------------------------------------------------------- finalise lines */

const byName = Object.fromEntries(stations.map((s) => [s.name, s]));

for (const f of features) {
  f.pts = simplify(f.pts, SIMPLIFY_M);
  f.cum = cumulative(f.pts);
  f.length = f.cum[f.cum.length - 1];
}

// Split Line 6 at Motijheel: operating today vs. the Kamlapur extension.
const l6 = features.find((f) => f.line === '6');
{
  const cut = nearest(byName['Motijheel'].xy, l6.pts, l6.cum).along;
  const operational = slice(l6.pts, l6.cum, 0, cut);
  const extension = slice(l6.pts, l6.cum, cut, l6.length);
  features.splice(features.indexOf(l6), 1,
    { line: '6', part: 'operational', kmlName: l6.kmlName, pts: operational },
    { line: '6', part: 'extension', kmlName: l6.kmlName, pts: extension },
  );
}
for (const f of features) {
  f.cum = cumulative(f.pts);
  f.length = f.cum[f.cum.length - 1];
  f.id = `${f.line}-${f.part}`;
}

/* ------------------------------------------------- station positions on lines */

const featureById = Object.fromEntries(features.map((f) => [f.id, f]));

for (const s of stations) {
  s.on = [];
  for (const f of features) {
    if (!s.lines.includes(f.line)) continue;
    const n = nearest(s.xy, f.pts, f.cum);
    if (n.d > TRACK_GAP_M + 20) continue;
    s.on.push({ feature: f.id, progress: +(n.along / f.length).toFixed(4), along: n.along });
  }
  if (!s.on.length) console.warn(`! ${s.name} is not on any line feature`);

  const depthByLine = {};
  for (const l of s.lines) {
    const cfg = DEPTH[l];
    if (cfg.default) depthByLine[l] = cfg.default;
    else if (cfg.underground.includes(s.name)) depthByLine[l] = 'underground';
    else if (cfg.elevated.includes(s.name)) depthByLine[l] = 'elevated';
    else {
      depthByLine[l] = 'unspecified';
      console.warn(`! No depth for ${s.name} on line ${l}`);
    }
  }
  s.depthByLine = depthByLine;
  const kinds = new Set(Object.values(depthByLine));
  s.depth = kinds.size === 1 ? [...kinds][0] : 'mixed';
}

/* -------------------------------------------------------- underground sections */

const sections = [];
for (const u of UNDERGROUND) {
  const f = featureById[`${u.line}-${u.part}`];
  const portal = (pair) => {
    if (!pair) return null;
    const a = nearest(byName[pair[0]].xy, f.pts, f.cum).along;
    const b = nearest(byName[pair[1]].xy, f.pts, f.cum).along;
    return (a + b) / 2;
  };
  const from = portal(u.from) ?? 0;
  const to = portal(u.to) ?? f.length;
  sections.push({
    line: u.line,
    feature: f.id,
    from: +(Math.min(from, to) / f.length).toFixed(4),
    to: +(Math.max(from, to) / f.length).toFixed(4),
    lengthKm: +((to - from) / 1000).toFixed(2),
    pts: slice(f.pts, f.cum, Math.min(from, to), Math.max(from, to)),
  });
}

/* ----------------------------------------------------------------- badges */

const badges = BADGES.map(({ line, station }) => {
  const s = byName[station];
  // Nudge the badge beyond the terminus, continuing the line's direction.
  const f = features
    .filter((x) => x.line === line)
    .map((x) => ({ x, n: nearest(s.xy, x.pts, x.cum) }))
    .sort((a, b) => a.n.d - b.n.d)[0].x;
  const atStart = nearest(s.xy, f.pts, f.cum).along < f.length / 2;
  const endPt = atStart ? f.pts[0] : f.pts[f.pts.length - 1];
  const inner = atStart ? f.pts[Math.min(3, f.pts.length - 1)] : f.pts[Math.max(0, f.pts.length - 4)];
  const dir = norm(sub(endPt, inner));
  return { line, station, xy: add(endPt, mul(dir, 520)) };
});

/* -------------------------------------------------------------- train path */

const op = featureById['6-operational'];
const trainStops = stations
  .flatMap((s) => s.on.filter((o) => o.feature === op.id).map((o) => ({ name: s.name, along: Math.round(o.along) })))
  .sort((a, b) => a.along - b.along);

/* ------------------------------------------------------------------ output */

const round = (n) => Math.round(n);
const out = {
  generated: new Date().toISOString().slice(0, 10),
  source: 'data/source/mrt-network.kml',
  lineOrder: LINE_ORDER,
  lines: {
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      properties: { id: f.id, line: f.line, part: f.part, lengthM: round(f.length) },
      geometry: { type: 'LineString', coordinates: f.pts.map(toLL) },
    })),
  },
  underground: {
    type: 'FeatureCollection',
    features: sections.map((s, i) => ({
      type: 'Feature',
      properties: { line: s.line, feature: s.feature, from: s.from, to: s.to, lengthKm: s.lengthKm },
      geometry: { type: 'LineString', coordinates: s.pts.map(toLL) },
    })),
  },
  stations: {
    type: 'FeatureCollection',
    features: stations
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s, i) => ({
        type: 'Feature',
        id: i + 1,
        properties: {
          id: s.id,
          name: s.name,
          lines: s.lines,
          // Flat copies for style expressions (no array handling needed on the GPU side).
          primary: s.lines[0],
          ...Object.fromEntries(LINE_ORDER.map((l) => [`has_${l}`, s.lines.includes(l)])),
          interchange: s.interchange,
          terminus: s.on.some((o) => {
            const part = o.feature.split('-')[1];
            if (o.feature === '6-operational' || o.feature === '6-extension') {
              return (o.feature === '6-operational' && o.progress < 0.02) || (o.feature === '6-extension' && o.progress > 0.98);
            }
            return part !== undefined && (o.progress < 0.02 || o.progress > 0.98);
          }),
          depth: s.depth,
          depthByLine: s.depthByLine,
          on: s.on.map(({ feature, progress }) => ({ feature, progress })),
        },
        geometry: { type: 'Point', coordinates: toLL(s.xy) },
      })),
  },
  badges: {
    type: 'FeatureCollection',
    features: badges.map((b) => ({
      type: 'Feature',
      properties: { line: b.line, station: b.station },
      geometry: { type: 'Point', coordinates: toLL(b.xy) },
    })),
  },
  train: {
    lengthM: round(op.length),
    path: op.pts.map(toLL),
    cumulativeM: op.cum.map(round),
    stops: trainStops,
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));

/* ---------------------------------------------------------------- summary */

const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(1);
console.log(`\nWrote ${OUT} (${kb} KB)`);
console.log(`Lines: ${features.map((f) => `${f.id} ${(f.length / 1000).toFixed(2)} km/${f.pts.length} pts`).join(' | ')}`);
console.log(`Underground: ${sections.map((s) => `${s.feature} ${s.lengthKm} km`).join(' | ')}`);
console.log(`Stations: ${stations.length}, interchanges: ${stations.filter((s) => s.interchange).map((s) => `${s.name} [${s.lines}]`).join(', ')}`);
console.log(`Train stops: ${trainStops.map((t) => t.name).join(' > ')}`);
for (const l of LINE_ORDER) {
  const list = stations.filter((s) => s.lines.includes(l));
  const ug = list.filter((s) => s.depthByLine[l] === 'underground').length;
  console.log(`  Line ${l}: ${list.length} stations (${ug} underground)`);
}
