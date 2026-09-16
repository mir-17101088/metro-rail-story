import type { FeatureId } from '../data/network';
import type { LineId } from '../data/lines';

/**
 * What the map shows at each scroll step. Keys match data-step in index.html.
 * The map engine diffs consecutive states, so scrolling backwards simply
 * replays these in reverse.
 */
export interface StepState {
  /** Line features drawn on the map. */
  features: FeatureId[];
  /** Lines at full strength; all others are dimmed. Omit for no emphasis. */
  focus?: LineId[];
  /** Opacity of lines outside the focus (default 0.3). */
  dim?: number;
  /** Spotlight underground sections: bold hollow tubes, elevated parts step back. */
  emphasizeUnderground?: boolean;
  /** Show underground sections as hollow lines. */
  depth?: boolean;
  /** How the unfinished Kamlapur extension is drawn. */
  extension?: 'dashed' | 'solid';
  /** Station labels (station ids) to show. */
  labels?: string[];
  /** Label every interchange and terminus instead of a fixed list. */
  labelKeyStations?: boolean;
  /** Camera frames these features (plus optional stations). */
  camera: {
    features: FeatureId[];
    stations?: string[];
    maxZoom?: number;
    key: string;
    /** Extra room (px) on the right, e.g. for a map annotation. */
    roomRight?: number;
  };
  annotation?: 'kamlapur';
  /** The map accepts clicks, hover and zoom. */
  interactive?: boolean;
}

const LINE_6: FeatureId[] = ['6-operational'];
const LINE_6_FULL: FeatureId[] = ['6-operational', '6-extension'];
const PHASE_2: FeatureId[] = [...LINE_6_FULL, '1-trunk', '1-branch', '5N-trunk'];
const PHASE_3: FeatureId[] = [...PHASE_2, '5S-trunk'];
const ALL: FeatureId[] = [...PHASE_3, '2-trunk', '2-branch', '4-trunk'];

const CAM_6 = { features: LINE_6_FULL, key: 'line-6' };
const CAM_2 = { features: PHASE_2, key: 'phase-2' };
/** Both Line 5S cards frame that line alone. */
const CAM_5S = { features: ['5S-trunk'] as FeatureId[], key: 'line-5s', maxZoom: 13, roomRight: 40 };

export const STEPS: Record<string, StepState> = {
  hero: {
    features: LINE_6,
    labels: [],
    camera: CAM_6,
  },
  plan: {
    features: LINE_6,
    labels: ['uttara-north', 'motijheel'],
    camera: CAM_6,
  },
  approval: {
    features: LINE_6,
    labels: ['uttara-north', 'motijheel'],
    camera: CAM_6,
  },
  cost6: {
    features: LINE_6,
    labels: ['uttara-north', 'agargaon', 'motijheel'],
    camera: CAM_6,
  },
  kamlapur: {
    features: LINE_6_FULL,
    extension: 'dashed',
    labels: ['motijheel', 'bangladesh-secretariat'],
    annotation: 'kamlapur',
    camera: {
      features: ['6-extension'],
      stations: ['bangladesh-secretariat', 'motijheel', 'kamlapur'],
      maxZoom: 14.6,
      key: 'kamlapur',
      roomRight: 150,
    },
  },
  'lines-1-5n': {
    features: PHASE_2,
    focus: ['1', '5N'],
    extension: 'dashed',
    labels: ['airport', 'purbachal-terminal', 'hemayetpur', 'vatara', 'kamlapur'],
    camera: CAM_2,
  },
  'lines-1-5n-routes': {
    features: PHASE_2,
    focus: ['1', '5N'],
    extension: 'dashed',
    labels: ['airport', 'kamlapur', 'notun-bazar', 'purbachal-terminal', 'hemayetpur', 'vatara'],
    camera: CAM_2,
  },
  'cost-revision': {
    features: PHASE_2,
    focus: ['1', '5N'],
    extension: 'dashed',
    labels: ['airport', 'purbachal-terminal', 'hemayetpur', 'vatara', 'kamlapur'],
    camera: CAM_2,
  },
  underground: {
    features: PHASE_2,
    // Line 6 is elevated: keep it muted so the subterranean sections lead.
    focus: ['1', '5N'],
    dim: 0.18,
    emphasizeUnderground: true,
    depth: true,
    extension: 'dashed',
    labels: ['kamlapur', 'airport', 'notun-bazar', 'gabtoli', 'mirpur-10'],
    camera: CAM_2,
  },
  'line-5s': {
    features: PHASE_3,
    focus: ['5S'],
    depth: true,
    extension: 'dashed',
    labels: ['gabtoli', 'dasherkandi', 'karwan-bazar'],
    camera: CAM_5S,
  },
  'line-5s-route': {
    features: PHASE_3,
    focus: ['5S'],
    depth: true,
    extension: 'dashed',
    labels: ['gabtoli', 'shyamoli', 'asad-gate', 'karwan-bazar', 'hatirjheel', 'tejgaon', 'aftabnagar', 'dasherkandi'],
    camera: CAM_5S,
  },
  network: {
    features: ALL,
    depth: true,
    extension: 'solid',
    labelKeyStations: true,
    interactive: true,
    camera: { features: ALL, key: 'all' },
  },
};

/** The order features are drawn in when several appear on the same step. */
export const DRAW_SEQUENCE: Partial<Record<FeatureId, { after?: FeatureId; at?: number; delay?: number }>> = {
  '1-branch': { after: '1-trunk', at: 0.5275 },
  '5N-trunk': { delay: 250 },
  '2-branch': { after: '2-trunk', at: 0.3423 },
  '4-trunk': { delay: 300 },
};
