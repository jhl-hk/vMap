export type Mode = 'map' | 'walk';

export interface InputHandlers {
  mode(): Mode;
  tap(x: number, y: number): void;
  pan(dx: number, dy: number): void;
  zoom(factor: number, cx: number, cy: number): void;
  key(code: string): void;
}

const JOY_R = 46;

/** Keyboard, floating joystick (walk mode), drag/pinch/wheel (map mode). */
export class Input {
  private keys = new Set<string>();
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
  private joyId = -1;
  private joyBase = { x: 0, y: 0 };
  private joyVec = { x: 0, y: 0 };
  private pinchDist = 0;
  private joyEl: HTMLElement;
  private knobEl: HTMLElement;

  constructor(private el: HTMLElement, private h: InputHandlers) {
    this.joyEl = document.getElementById('joy')!;
    this.knobEl = this.joyEl.firstElementChild as HTMLElement;
    addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      this.keys.add(e.code);
      if (!e.repeat) h.key(e.code);
      // Enter opens the chat box; without preventDefault its keypress would submit the empty form
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Enter') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0015);
      h.zoom(f, e.clientX, e.clientY);
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Movement vector (|v| <= 1) and run flag. */
  axis(): { x: number; y: number; run: boolean } {
    let x = 0, y = 0;
    const k = this.keys;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y += 1;
    if (x || y) {
      const l = Math.hypot(x, y);
      return { x: x / l, y: y / l, run: k.has('ShiftLeft') || k.has('ShiftRight') };
    }
    const m = Math.hypot(this.joyVec.x, this.joyVec.y);
    if (m < 0.15) return { x: 0, y: 0, run: false };
    return { x: this.joyVec.x, y: this.joyVec.y, run: m > 0.92 };
  }

  resetJoystick() {
    this.joyId = -1;
    this.joyVec.x = this.joyVec.y = 0;
    this.joyEl.hidden = true;
  }

  private down(e: PointerEvent) {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
    if (this.pointers.size === 2) {
      this.resetJoystick();
      this.pinchDist = this.spread();
      return;
    }
    if (this.h.mode() === 'walk' && this.pointers.size === 1 && e.pointerType !== 'mouse') {
      this.joyId = e.pointerId;
      this.joyBase = { x: e.clientX, y: e.clientY };
      this.joyVec.x = this.joyVec.y = 0;
      this.joyEl.hidden = false;
      this.joyEl.style.transform = `translate(${e.clientX - JOY_R}px, ${e.clientY - JOY_R}px)`;
      this.knobEl.style.transform = 'translate(0px, 0px)';
    }
  }

  private move(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 2) {
      const d = this.spread();
      const [a, b] = [...this.pointers.values()];
      if (this.pinchDist > 0) this.h.zoom(d / this.pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      this.pinchDist = d;
      if (this.h.mode() === 'map') this.h.pan(dx / 2, dy / 2);
      return;
    }
    if (e.pointerId === this.joyId) {
      let vx = e.clientX - this.joyBase.x, vy = e.clientY - this.joyBase.y;
      const l = Math.hypot(vx, vy);
      if (l > JOY_R) { vx = (vx / l) * JOY_R; vy = (vy / l) * JOY_R; }
      this.joyVec.x = vx / JOY_R;
      this.joyVec.y = vy / JOY_R;
      this.knobEl.style.transform = `translate(${vx}px, ${vy}px)`;
      return;
    }
    if (this.h.mode() === 'map') this.h.pan(dx, dy);
  }

  private up(e: PointerEvent, cancel = false) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (e.pointerId === this.joyId) this.resetJoystick();
    if (!p || cancel) return;
    const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
    if (moved < 8 && performance.now() - p.t < 400 && this.pointers.size === 0) this.h.tap(e.clientX, e.clientY);
  }

  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}
