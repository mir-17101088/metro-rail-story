/**
 * Line metadata shown in the network explorer.
 * Every figure here comes from the story text (MRT story line.docx). Keep the
 * two in sync when the copy desk edits numbers.
 */

export type LineId = '6' | '1' | '5N' | '5S' | '2' | '4';

export const LINE_ORDER: LineId[] = ['6', '1', '5N', '5S', '2', '4'];

export interface LineMeta {
  id: LineId;
  name: string;
  color: string;
  route: string;
  status: string;
  facts: Array<[label: string, value: string]>;
}

export const LINES: Record<LineId, LineMeta> = {
  '6': {
    id: '6',
    name: 'Line 6',
    color: '#5ddca5',
    route: 'Uttara North to Kamlapur',
    status:
      'Runs on elevated piers from Uttara North to Motijheel. Kamlapur station is 77.2% built and due to be added by early 2027.',
    facts: [
      ['Cost at inception', 'Tk 21,985 crore'],
      ['Cost by 2022', 'Tk 33,472 crore'],
    ],
  },
  '1': {
    id: '1',
    name: 'Line 1',
    color: '#e4303c',
    route: 'Kamlapur to Airport, with a Purbachal branch',
    status: "Approved on October 15, 2019. It will be the country's first subway.",
    facts: [
      ['Underground', '19.87 km'],
      ['Elevated', '11.37 km'],
      ['Underground stations', '12 of 21'],
      ['Revised cost, Lines 1 and 5N', 'Tk 2,03,800 crore'],
    ],
  },
  '5N': {
    id: '5N',
    name: 'Line 5 North',
    color: '#52acf2',
    route: 'Hemayetpur to Vatara',
    status: 'Approved on October 15, 2019, alongside Line 1.',
    facts: [
      ['Underground stations', '9 of 14'],
      ['Revised cost, Lines 1 and 5N', 'Tk 2,03,800 crore'],
    ],
  },
  '5S': {
    id: '5S',
    name: 'Line 5 South',
    color: '#e9853e',
    route: 'Gabtoli to Dasherkandi',
    status: 'Approved by ECNEC with loan assistance from the ADB and South Korea. The project runs to August 2033.',
    facts: [
      ['Estimated cost', 'Tk 45,503 crore'],
      ['Length', '17.4 km'],
      ['Underground', '12.8 km'],
      ['Elevated', '4.6 km'],
    ],
  },
  '2': {
    id: '2',
    name: 'Line 2',
    color: '#7e62d6',
    route: 'Gabtoli to Narayanganj, with a Sadarghat branch',
    status: 'Part of the planned six-line network.',
    facts: [],
  },
  '4': {
    id: '4',
    name: 'Line 4',
    color: '#f0ca2c',
    route: 'Kamlapur to Madanpur',
    status: 'Part of the planned six-line network.',
    facts: [],
  },
};

export const DEPTH_LABEL: Record<string, string> = {
  underground: 'Underground',
  elevated: 'Elevated',
  unspecified: 'Not yet specified',
};
