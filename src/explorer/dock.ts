import { prefersReducedMotion } from '../lib/motion';

/**
 * Makes room for the map around the network explorer.
 *
 * Desktop: a tab on the panel's edge slides the whole panel off to the left
 * (and back), so the full network can be seen edge to edge.
 *
 * Phones: the panel is a bottom sheet. Its grip can be dragged to any height,
 * flicked down to minimise or up to expand, pressed to toggle, or nudged with
 * the arrow keys. A chevron button minimises and restores it too.
 *
 * `onLayout` fires once a change has settled, so the map can re-frame itself
 * around the space that is now free.
 */

const WIDE = window.matchMedia('(min-width: 1024px)');

/** Release speed (px/ms) that counts as a flick. */
const FLICK = 0.45;
/** Below this body height a release minimises the sheet. */
const MIN_OPEN = 72;
const SNAP_MS = 380;
/** Share of the screen the whole sheet may cover when expanded. */
const ROOM = 0.78;

/**
 * How tall the open sheet is:
 * - 'auto': sized by its content, up to a comfortable half screen (the default)
 * - 'full': sized by its content, up to most of the screen (after a flick up)
 * - a number: the exact body height the reader dragged it to
 */
type SheetSize = 'auto' | 'full' | number;

export class Dock {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly grip: HTMLButtonElement;
  private readonly toggle: HTMLButtonElement;
  private readonly listeners = new Set<() => void>();

  private collapsed = false;
  private minimized = false;
  private size: SheetSize = 'auto';
  private settleTimer = 0;
  /** Increments per height animation, so a superseded one cannot clean up after the next. */
  private animation = 0;

  constructor(private readonly root: HTMLElement) {
    this.panel = root.querySelector('[data-dock-panel]')!;
    this.body = root.querySelector('[data-dock-body]')!;
    this.tab = root.querySelector('[data-dock-tab]')!;
    this.grip = root.querySelector('[data-sheet-grip]')!;
    this.toggle = root.querySelector('[data-sheet-toggle]')!;

    for (const control of [this.tab, this.grip, this.toggle]) control.removeAttribute('hidden');

    this.tab.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.toggle.addEventListener('click', () => this.setMinimized(!this.minimized));
    this.bindGrip();

    WIDE.addEventListener('change', () => this.reset());
  }

  onLayout(listener: () => void): void {
    this.listeners.add(listener);
  }

  /**
   * Call after the panel's content changes. If the reader had dragged the
   * sheet taller than what it now holds, drop back to content-driven sizing
   * at once, before the map measures the sheet to frame the new selection.
   */
  fitContent(): void {
    if (WIDE.matches || this.minimized || typeof this.size !== 'number') return;
    if (this.contentHeight() >= this.size) return;
    this.setSize('auto');
    this.instantly(() => (this.body.style.height = ''));
  }

  /**
   * Bring the explorer back into view: a click on the map should always show
   * what was picked, even when the reader had minimised the tray (or slid the
   * desktop panel away).
   *
   * Call it before the map frames the selection. The final size is applied
   * synchronously (and published through `data-settled-height` while the tray
   * animates), so the map frames once, with the right padding, instead of
   * moving twice.
   */
  reveal(): void {
    if (WIDE.matches) {
      if (this.collapsed) this.setCollapsed(false, false);
      return;
    }
    if (!this.minimized) return;
    // A height the reader dragged too short to show the details gives way to content sizing.
    if (typeof this.size === 'number' && this.size < this.naturalHeight()) this.setSize('auto');
    this.setMinimized(false, undefined, false);
  }

  /* ------------------------------------------------------------ desktop */

  private setCollapsed(on: boolean, notify = true): void {
    if (on === this.collapsed || !WIDE.matches) return;
    this.collapsed = on;
    this.root.toggleAttribute('data-collapsed', on);
    this.panel.inert = on;
    this.tab.setAttribute('aria-expanded', String(!on));
    this.label(this.tab, on ? 'Show the network panel' : 'Hide the network panel');
    // The camera glides alongside the panel rather than after it.
    if (notify) this.emit(0);
  }

  /* ------------------------------------------------------------- phones */

  private setSize(size: SheetSize): void {
    this.size = size;
    this.root.toggleAttribute('data-sheet-full', size === 'full');
  }

  /** Tallest the sheet body may be: never past its content, never over most of the screen. */
  private maxBodyHeight(): number {
    const head = this.panel.offsetHeight - this.body.offsetHeight;
    const room = Math.round(window.innerHeight * ROOM) - head;
    return Math.max(MIN_OPEN + 24, Math.min(room, this.contentHeight()));
  }

  /** Full height of the body's content, measured without any size constraint. */
  private contentHeight(): number {
    const { height, maxHeight } = this.body.style;
    let content = 0;
    this.instantly(() => {
      this.body.style.height = 'auto';
      this.body.style.maxHeight = 'none';
      content = this.body.scrollHeight;
      this.body.style.height = height;
      this.body.style.maxHeight = maxHeight;
    });
    return content;
  }

  /** Height the open sheet settles at for the current size mode. */
  private openHeight(): number {
    if (typeof this.size === 'number') return Math.min(this.size, this.maxBodyHeight());
    return this.naturalHeight();
  }

  /** Body height when CSS sizes it by its content (within the current mode's cap). */
  private naturalHeight(): number {
    const { height } = this.body.style;
    let natural = 0;
    this.instantly(() => {
      this.body.style.height = '';
      natural = this.body.offsetHeight;
      this.body.style.height = height;
    });
    return natural;
  }

  private setMinimized(on: boolean, fromHeight?: number, notify = true): void {
    if (WIDE.matches) return;
    if (on === this.minimized && fromHeight === undefined) return;
    const start = fromHeight ?? (this.minimized ? 0 : this.body.offsetHeight);
    this.minimized = on;
    this.root.toggleAttribute('data-minimized', on);
    this.body.inert = on;
    this.syncExpanded();

    this.animateBody(start, on ? 0 : this.openHeight());
    if (notify) this.emit(SNAP_MS);
  }

  /**
   * Height changes run as a CSS transition between explicit pixel values. Once
   * an open sheet lands, content-sized modes hand control back to CSS so the
   * sheet keeps following its content (a line being selected, say).
   */
  private animateBody(from: number, to: number): void {
    const body = this.body;
    const root = this.root;
    const id = ++this.animation;
    const settle = () => {
      // A newer animation (or a drag) took over: leave its state alone.
      if (id !== this.animation) return;
      if (!this.minimized && typeof this.size !== 'number') body.style.height = '';
      delete root.dataset.settledHeight;
    };
    this.instantly(() => (body.style.height = `${from}px`));
    // What the tray will measure once it lands, for anything framing around it meanwhile.
    root.dataset.settledHeight = String(root.offsetHeight - from + to);
    if (prefersReducedMotion() || Math.abs(from - to) < 1) {
      this.instantly(() => (body.style.height = `${to}px`));
      settle();
      return;
    }
    body.style.height = `${to}px`;
    const finish = (event?: TransitionEvent) => {
      if (event && (event.target !== body || event.propertyName !== 'height')) return;
      body.removeEventListener('transitionend', finish);
      window.clearTimeout(fallback);
      settle();
    };
    const fallback = window.setTimeout(finish, SNAP_MS + 80);
    body.addEventListener('transitionend', finish);
  }

  /** Apply style changes with transitions suspended, flushed before they resume. */
  private instantly(change: () => void): void {
    const { transition } = this.body.style;
    this.body.style.transition = 'none';
    change();
    void this.body.offsetHeight;
    this.body.style.transition = transition;
  }

  private bindGrip(): void {
    const grip = this.grip;
    let pointer: number | null = null;
    let startY = 0;
    let startHeight = 0;
    let max = 0;
    let moved = false;
    let samples: Array<{ y: number; t: number }> = [];
    let frame = 0;
    let pendingHeight = 0;

    const render = () => {
      frame = 0;
      this.body.style.height = `${pendingHeight}px`;
    };

    grip.addEventListener('pointerdown', (event) => {
      // One finger at a time: a second touch must not make the sheet jump.
      if (pointer !== null || WIDE.matches || (event.pointerType === 'mouse' && event.button !== 0)) return;
      pointer = event.pointerId;
      grip.setPointerCapture(pointer);
      startY = event.clientY;
      startHeight = this.minimized ? 0 : this.body.offsetHeight;
      // Measured once per drag: layout reads on every pointermove would stutter.
      max = this.maxBodyHeight();
      moved = false;
      samples = [{ y: event.clientY, t: event.timeStamp }];
    });

    grip.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointer) return;
      const dy = event.clientY - startY;
      if (!moved && Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        this.animation++;
        delete this.root.dataset.settledHeight;
        this.root.setAttribute('data-dragging', '');
        if (this.minimized) {
          this.minimized = false;
          this.root.removeAttribute('data-minimized');
          this.body.inert = false;
        }
      }
      let height = startHeight - dy;
      // Friction past either end instead of a hard stop.
      if (height > max) height = max + (height - max) * 0.2;
      if (height < 0) height *= 0.2;
      pendingHeight = Math.max(0, Math.round(height));
      samples.push({ y: event.clientY, t: event.timeStamp });
      if (samples.length > 6) samples.shift();
      if (!frame) frame = requestAnimationFrame(render);
    });

    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      cancelAnimationFrame(frame);
      frame = 0;
      if (moved) this.body.style.height = `${pendingHeight}px`;
      this.root.removeAttribute('data-dragging');

      if (!moved) {
        // A press without a drag toggles the sheet.
        if (event.type === 'pointerup') this.setMinimized(!this.minimized);
        return;
      }

      const current = this.body.offsetHeight;
      const first = samples[0];
      const last = samples[samples.length - 1];
      // Speed over the last few moves: how the finger was travelling as it let go.
      const velocity = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;

      if (velocity > FLICK || current < MIN_OPEN) {
        this.setMinimized(true, current);
      } else if (velocity < -FLICK || current >= max - 12) {
        this.setSize('full');
        this.setMinimized(false, current);
      } else {
        this.setSize(Math.min(max, current));
        this.setMinimized(false, current);
      }
    };
    grip.addEventListener('pointerup', release);
    grip.addEventListener('pointercancel', release);

    // Pointer presses are handled on release; keyboard presses arrive as clicks with detail 0.
    grip.addEventListener('click', (event) => {
      if (event.detail === 0) this.setMinimized(!this.minimized);
    });

    grip.addEventListener('keydown', (event) => {
      if (WIDE.matches || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      const from = this.minimized ? 0 : this.body.offsetHeight;
      const limit = this.maxBodyHeight();
      const to = Math.max(0, Math.min(limit, from + (event.key === 'ArrowUp' ? 56 : -56)));
      if (to < MIN_OPEN) {
        this.setMinimized(true, from);
        return;
      }
      this.setSize(to >= limit ? 'full' : to);
      this.setMinimized(false, from);
    });
  }

  private syncExpanded(): void {
    for (const control of [this.grip, this.toggle]) control.setAttribute('aria-expanded', String(!this.minimized));
    this.label(this.toggle, this.minimized ? 'Expand the network panel' : 'Minimise the network panel');
  }

  /* ------------------------------------------------------------- shared */

  /** Crossing the desktop/phone breakpoint starts both layouts fresh. */
  private reset(): void {
    this.collapsed = false;
    this.minimized = false;
    this.setSize('auto');
    this.root.removeAttribute('data-collapsed');
    this.root.removeAttribute('data-minimized');
    this.panel.inert = false;
    this.body.inert = false;
    this.body.style.height = '';
    this.body.style.transition = '';
    this.tab.setAttribute('aria-expanded', 'true');
    this.label(this.tab, 'Hide the network panel');
    this.syncExpanded();
  }

  private label(button: HTMLElement, text: string): void {
    const label = button.querySelector('[data-label]');
    if (label) label.textContent = text;
  }

  private emit(delay: number): void {
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.listeners.forEach((listener) => listener()), delay);
  }
}
