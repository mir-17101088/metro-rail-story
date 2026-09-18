/**
 * Line metadata shown in the network explorer.
 * Figures come from the story text (MRT story line.docx) and the editors' cost
 * table (initial vs revised cost per line). Keep them in sync with index.html
 * (story cards, timeline, cost chart) when the copy desk edits numbers.
 */

export type LineId = '6' | '1' | '5N' | '5S' | '2' | '4';

export const LINE_ORDER: LineId[] = ['6', '1', '5N', '5S', '2', '4'];

/**
 * When a line can carry passengers end to end: already running, a project
 * completion deadline, or no deadline yet because the line is still being planned.
 */
export type Completion = 'running' | 'planning' | { year: number; month: number };

export interface LineMeta {
  id: LineId;
  name: string;
  color: string;
  route: string;
  status: string;
  facts: Array<[label: string, value: string]>;
  /** Used by the route game to say when a trip becomes possible. */
  completion: Completion;
}

/** When Line 6's last station, Kamlapur, is due to open (see the kamlapur step in index.html). */
export const KAMLAPUR_OPENING = 'early 2027';

export const LINES: Record<LineId, LineMeta> = {
  '6': {
    id: '6',
    name: 'Line 6',
    color: '#5ddca5',
    route: 'Uttara North to Kamlapur',
    status:
      'Runs on elevated piers from Uttara North to Motijheel. Kamlapur station is 77.2% built and due to be added by early 2027.',
    facts: [
      ['Initial cost', 'Tk 21,985.07 crore'],
      ['Revised cost', 'Tk 32,717.72 crore'],
      ['Cost increase', '48.82%'],
      ['Length', '21.26 km'],
    ],
    completion: 'running',
  },
  '1': {
    id: '1',
    name: 'Line 1',
    color: '#e4303c',
    route: 'Kamlapur to Airport, with a Purbachal branch',
    status:
      "Approved on October 15, 2019, with a revised cost approved on September 16, 2026. It will be the country's first subway. Completion deadline: December 2035.",
    facts: [
      ['Initial cost', 'Tk 52,561 crore'],
      ['Revised cost', 'Tk 1,20,794 crore'],
      ['Second revised cost', 'Tk 1,14,394 crore'],
      ['Cost increase', '117.64%'],
      ['Length', '31.24 km'],
      ['Underground', '19.87 km'],
      ['Elevated', '11.37 km'],
      ['Underground stations', '12 of 21'],
    ],
    completion: { year: 2035, month: 12 },
  },
  '5N': {
    id: '5N',
    name: 'Line 5 North',
    color: '#52acf2',
    route: 'Hemayetpur to Vatara',
    status:
      'Approved on October 15, 2019, alongside Line 1, with a revised cost approved on September 16, 2026. Completion deadline: December 2034.',
    facts: [
      ['Initial cost', 'Tk 41,238.54 crore'],
      ['Revised cost', 'Tk 93,190 crore'],
      ['Second revised cost', 'Tk 89,848 crore'],
      ['Cost increase', '117.87%'],
      ['Length', '20 km'],
      ['Underground stations', '9 of 14'],
    ],
    completion: { year: 2034, month: 12 },
  },
  '5S': {
    id: '5S',
    name: 'Line 5 South',
    color: '#e9853e',
    route: 'Gabtoli to Dasherkandi',
    status:
      'Approved by ECNEC on September 16, 2026, at a revised cost below its initial estimate. Completion deadline: August 2033.',
    facts: [
      ['Initial cost', 'Tk 54,619 crore'],
      ['Revised cost', 'Tk 45,504 crore'],
      ['Cost decrease', '16.69%'],
      ['Length', '17.2 km'],
      ['Underground', '12.8 km'],
      ['Elevated', '4.4 km'],
      ['Underground stations', '11 of 15'],
    ],
    completion: { year: 2033, month: 8 },
  },
  '2': {
    id: '2',
    name: 'Line 2',
    color: '#7e62d6',
    route: 'Gabtoli to Narayanganj, with a Sadarghat branch',
    status: 'Still in the planning stage. No completion deadline has been set.',
    facts: [['Initial cost', 'Tk 61,000 crore']],
    completion: 'planning',
  },
  '4': {
    id: '4',
    name: 'Line 4',
    color: '#f0ca2c',
    route: 'Kamlapur to Madanpur',
    status: 'Still in the planning stage. No completion deadline has been set.',
    facts: [['Initial cost', 'Tk 28,400 crore']],
    completion: 'planning',
  },
};

/** Lines with no completion deadline yet. */
export const PLANNING_LINES: LineId[] = LINE_ORDER.filter((line) => LINES[line].completion === 'planning');

export const DEPTH_LABEL: Record<string, string> = {
  underground: 'Underground',
  elevated: 'Elevated',
  unspecified: 'Not yet specified',
};
