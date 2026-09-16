import { LINES, DEPTH_LABEL, type LineId } from '../data/lines';
import { stationById, stationsOfLine, type StationFeature } from '../data/network';

/**
 * The network explorer's DOM: line buttons and the detail area.
 * It works on its own (keyboard, screen readers, no WebGL); the map
 * subscribes to its selection events when it is available.
 */

export type Selection = { kind: 'line'; line: LineId } | { kind: 'station'; id: string; from?: LineId } | null;

type Listener = (selection: Selection) => void;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const cssVar = (line: LineId) => `var(--line-${line.toLowerCase()})`;

const badge = (line: LineId, small = false) =>
  `<span class="badge${small ? ' badge--sm' : ''}" style="--c: ${cssVar(line)}" aria-hidden="true">${line}</span>`;

export class NetworkPanel {
  private selection: Selection = null;
  private readonly listeners = new Set<Listener>();
  private readonly list: HTMLElement;
  private readonly buttons: HTMLButtonElement[];
  private readonly detail: HTMLElement;

  constructor(root: HTMLElement) {
    this.list = root.querySelector('.lines')!;
    this.buttons = [...root.querySelectorAll<HTMLButtonElement>('.line-btn')];
    this.detail = root.querySelector('[data-detail]')!;

    const hint = root.querySelector<HTMLElement>('.network__hint');
    if (hint) {
      hint.removeAttribute('hidden');
      // Plain scrolling always moves the story; zooming the map needs a modifier.
      if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        const mac = /Mac|iPhone|iPad/.test(navigator.platform);
        hint.textContent += mac ? ' Pinch, or hold ⌘ and scroll, to zoom.' : ' Hold Ctrl and scroll to zoom.';
      }
    }

    for (const button of this.buttons) {
      button.addEventListener('click', () => {
        const line = button.dataset.line as LineId;
        const same = this.selection?.kind === 'line' && this.selection.line === line;
        this.select(same ? null : { kind: 'line', line });
      });
    }

    this.detail.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-station],[data-back]');
      if (!target) return;
      if (target.dataset.back !== undefined) {
        const back = target.dataset.back as LineId | '';
        this.select(back ? { kind: 'line', line: back } : null);
        return;
      }
      const from = this.selection?.kind === 'line' ? this.selection.line : undefined;
      this.select({ kind: 'station', id: target.dataset.station!, from });
    });
  }

  onChange(listener: Listener): void {
    this.listeners.add(listener);
  }

  get current(): Selection {
    return this.selection;
  }

  select(selection: Selection, { silent = false } = {}): void {
    this.selection = selection;
    const activeLine = selection?.kind === 'line' ? selection.line : null;
    for (const b of this.buttons) b.setAttribute('aria-pressed', String(b.dataset.line === activeLine));
    if (activeLine) this.list.setAttribute('data-selection', '');
    else this.list.removeAttribute('data-selection');
    this.render();
    if (!silent) for (const l of this.listeners) l(selection);
  }

  private render(): void {
    const s = this.selection;
    if (!s) {
      this.detail.innerHTML = '';
      return;
    }
    if (s.kind === 'line') {
      this.detail.innerHTML = this.lineDetail(s.line);
      return;
    }
    const station = stationById.get(s.id);
    this.detail.innerHTML = station ? this.stationDetail(station, s.from) : '';
  }

  private lineDetail(line: LineId): string {
    const meta = LINES[line];
    const facts = meta.facts.length
      ? `<dl class="facts">${meta.facts
          .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
          .join('')}</dl>`
      : '';
    const stations = stationsOfLine(line)
      .map(
        (st) =>
          `<li><button class="station-btn" type="button" data-station="${esc(st.properties.id)}"${
            st.properties.interchange ? ' data-interchange' : ''
          }>${esc(st.properties.name)}</button></li>`,
      )
      .join('');
    return `
      <div class="detail__head">${badge(line)}<h3 class="detail__title">${esc(meta.name)}</h3></div>
      <p class="detail__status">${esc(meta.status)}</p>
      ${facts}
      <ol class="stations" aria-label="Stations on ${esc(meta.name)}">${stations}</ol>`;
  }

  private stationDetail(station: StationFeature, from?: LineId): string {
    const p = station.properties;
    const served = p.lines
      .map(
        (l) =>
          `<li>${badge(l, true)}<span>${esc(LINES[l].name)}</span><span class="served__depth">${esc(
            DEPTH_LABEL[p.depthByLine[l] ?? 'unspecified'] ?? '',
          )}</span></li>`,
      )
      .join('');
    const note =
      p.id === 'kamlapur'
        ? '<p class="detail__status">The Line 6 station here is 77.2% built and due to be added by early 2027.</p>'
        : '';
    const kind = p.interchange ? `Interchange for ${p.lines.length} lines` : 'Station';
    return `
      <div class="detail__head"><h3 class="detail__title">${esc(p.name)}</h3></div>
      <p class="detail__status">${esc(kind)}</p>
      ${note}
      <ul class="served" role="list">${served}</ul>
      <button class="detail__back" type="button" data-back="${from ?? ''}">${
        from ? `Back to ${esc(LINES[from].name)}` : 'Show all lines'
      }</button>`;
  }
}
