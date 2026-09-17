import type { LineId } from '../data/lines';
import { network } from '../data/network';

/**
 * A searchable station field: an ARIA 1.2 combobox with a list popup.
 *
 * Focus opens the full list (80 stations, each with its line badges); typing
 * narrows it, matching the start of the name first, then the start of any
 * word, then anywhere. Arrow keys move through the list, Enter picks, Escape
 * closes. Leaving the field with an exact name picks that station; leaving it
 * empty clears it; anything else restores the previous pick.
 */

export type CommitSource = 'list' | 'text' | 'clear';

interface Entry {
  id: string;
  name: string;
  lines: LineId[];
  /** Normalised name and alternative spellings. */
  keys: string[];
  /** Normalised words of the name, for "starts a word" matches. */
  words: string[];
  option: HTMLLIElement;
}

/** Spellings readers are likely to type that differ from the map's station names. */
const ALIASES: Record<string, string[]> = {
  kamlapur: ['kamalapur'],
  'notun-bazar': ['natun bazar'],
  vatara: ['bhatara'],
  shahbagh: ['shahbag'],
  motijheel: ['motijhil'],
  hatirjheel: ['hatirjhil'],
  kallyanpur: ['kalyanpur'],
  'russel-square': ['russell square'],
  sayedabad: ['saidabad'],
  'dar-us-salam': ['darussalam'],
  'bangladesh-secretariat': ['secretariat', 'sachibalaya'],
  dmch: ['dhaka medical college'],
  airport: ['shahjalal', 'hazrat shahjalal'],
  'joar-sahara': ['jowar sahara'],
  'dhaka-uddan': ['dhaka udyan'],
};

const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const badge = (line: LineId) =>
  `<span class="badge badge--xs" style="--c: var(--line-${line.toLowerCase()})">${line}</span>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class StationPicker {
  private readonly input: HTMLInputElement;
  private readonly popup: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly empty: HTMLElement;
  private readonly entries: Entry[];
  private readonly byId: Map<string, Entry>;
  private visible: Entry[] = [];
  private active = -1;
  private selected: string | null = null;
  private pointerInside = false;
  private listener: (id: string | null, source: CommitSource) => void = () => {};

  constructor(private readonly root: HTMLElement) {
    this.input = root.querySelector('input')!;
    this.popup = root.querySelector('[data-picker-popup]')!;
    this.list = root.querySelector('[role="listbox"]')!;
    this.empty = root.querySelector('[data-picker-empty]')!;

    this.entries = network.stations.features
      .map((s) => {
        const { id, name, lines } = s.properties;
        const option = document.createElement('li');
        option.id = `${this.list.id}-${id}`;
        option.className = 'picker__option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.dataset.id = id;
        option.innerHTML = `<span class="picker__name">${esc(name)}</span><span class="picker__lines" aria-hidden="true">${lines
          .map(badge)
          .join('')}</span>`;
        return {
          id,
          name,
          lines,
          keys: [name, ...(ALIASES[id] ?? [])].map(normalize),
          words: name.split(/[\s-]+/).map(normalize),
          option,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    this.byId = new Map(this.entries.map((e) => [e.id, e]));
    this.show(this.entries);

    this.bind();
  }

  /** Called when the reader picks or clears a station (not when `value` is set in code). */
  onCommit(listener: (id: string | null, source: CommitSource) => void): void {
    this.listener = listener;
  }

  get value(): string | null {
    return this.selected;
  }

  set value(id: string | null) {
    this.select(id && this.byId.has(id) ? id : null);
  }

  focus(): void {
    this.input.focus();
  }

  get field(): HTMLInputElement {
    return this.input;
  }

  /* ---------------------------------------------------------------- events */

  private bind(): void {
    const { input, popup, list } = this;

    input.addEventListener('focus', () => {
      this.open('');
      // Typing replaces the current pick instead of appending to it.
      window.setTimeout(() => {
        if (document.activeElement === input) input.select();
      }, 0);
    });

    input.addEventListener('click', () => {
      if (!this.isOpen) this.open('');
    });

    input.addEventListener('input', () => this.open(input.value));

    input.addEventListener('keydown', (event) => {
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          event.preventDefault();
          if (!this.isOpen) {
            this.open('');
            return;
          }
          const step = event.key === 'ArrowDown' ? 1 : -1;
          const next = this.active < 0 ? (step > 0 ? 0 : this.visible.length - 1) : this.active + step;
          this.setActive(Math.max(0, Math.min(this.visible.length - 1, next)), true);
          break;
        }
        case 'Enter':
          if (this.isOpen && this.active >= 0) {
            event.preventDefault();
            this.commit(this.visible[this.active].id, 'list');
          }
          break;
        case 'Escape':
          if (this.isOpen) {
            event.preventDefault();
            this.close();
            this.input.value = this.selectedName;
          }
          break;
        default:
      }
    });

    // Keep focus in the field while the pointer is on the list (and on phones,
    // where a tap on the list can blur the field before the click lands).
    popup.addEventListener('pointerdown', (event) => {
      this.pointerInside = true;
      if (event.pointerType === 'mouse') event.preventDefault();
    });
    const release = () => window.setTimeout(() => (this.pointerInside = false), 0);
    popup.addEventListener('pointerup', release);
    popup.addEventListener('pointercancel', release);

    list.addEventListener('click', (event) => {
      const option = (event.target as HTMLElement).closest<HTMLLIElement>('[role="option"]');
      if (option?.dataset.id) this.commit(option.dataset.id, 'list');
    });

    list.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      const option = (event.target as HTMLElement).closest<HTMLLIElement>('[role="option"]');
      const index = option ? this.visible.findIndex((e) => e.option === option) : -1;
      if (index >= 0 && index !== this.active) this.setActive(index, false);
    });

    this.root.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (this.root.contains(document.activeElement) || this.pointerInside) return;
        if (this.isOpen) this.resolveText();
      }, 0);
    });
  }

  /* ----------------------------------------------------------------- state */

  private get isOpen(): boolean {
    return !this.popup.hidden;
  }

  private get selectedName(): string {
    return this.selected ? this.byId.get(this.selected)!.name : '';
  }

  private open(query: string): void {
    // The field still shows the current pick: list everything, with it in view.
    const typed = normalize(query) !== normalize(this.selectedName) ? query : '';
    this.show(this.match(typed));
    this.popup.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');

    const current = this.visible.findIndex((e) => e.id === this.selected);
    if (!typed && current >= 0) this.setActive(current, true);
    else this.setActive(this.visible.length && typed ? 0 : -1, true);
    if (!typed && current < 0) this.list.scrollTop = 0;
  }

  private close(): void {
    this.popup.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  private match(query: string): Entry[] {
    const q = normalize(query);
    if (!q) return this.entries;
    const ranked: Array<[number, Entry]> = [];
    for (const entry of this.entries) {
      let rank = -1;
      if (entry.keys.some((k) => k.startsWith(q))) rank = 0;
      else if (entry.words.some((w) => w.startsWith(q))) rank = 1;
      else if (entry.keys.some((k) => k.includes(q))) rank = 2;
      if (rank >= 0) ranked.push([rank, entry]);
    }
    // Stable sort keeps alphabetical order within each rank.
    return ranked.sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  }

  private show(entries: Entry[]): void {
    if (entries.length !== this.visible.length || entries.some((e, i) => e !== this.visible[i])) {
      this.list.replaceChildren(...entries.map((e) => e.option));
    }
    this.visible = entries;
    this.empty.hidden = entries.length > 0;
  }

  private setActive(index: number, scroll: boolean): void {
    this.visible[this.active]?.option.removeAttribute('data-active');
    this.active = index;
    const entry = this.visible[index];
    if (!entry) {
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    entry.option.setAttribute('data-active', '');
    this.input.setAttribute('aria-activedescendant', entry.option.id);
    if (scroll) entry.option.scrollIntoView({ block: 'nearest' });
  }

  private resolveText(): void {
    const text = normalize(this.input.value);
    this.close();
    if (!text) {
      if (this.selected) this.commit(null, 'clear');
      return;
    }
    const exact = this.entries.find((e) => e.keys.includes(text));
    if (exact && exact.id !== this.selected) this.commit(exact.id, 'text');
    else this.input.value = this.selectedName;
  }

  private commit(id: string | null, source: CommitSource): void {
    this.select(id);
    this.close();
    this.listener(this.selected, source);
  }

  private select(id: string | null): void {
    if (this.selected) this.byId.get(this.selected)?.option.setAttribute('aria-selected', 'false');
    this.selected = id;
    if (id) this.byId.get(id)!.option.setAttribute('aria-selected', 'true');
    this.input.value = this.selectedName;
    this.root.toggleAttribute('data-filled', Boolean(id));
  }
}
