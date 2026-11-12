/** Integer hash -> [0, 2^32). Stable across runs, used for procedural variation. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type RGB = [number, number, number];

export function hex(c: string): RGB {
  const v = parseInt(c.slice(1, 7), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function css(c: RGB, a = 1): string {
  return a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
}

export function shade(c: RGB, k: number): RGB {
  return [clamp255(c[0] * k), clamp255(c[1] * k), clamp255(c[2] * k)];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** RGBA packed for little-endian Uint32 ImageData views. */
export function pack(c: RGB, a = 255): number {
  return ((a << 24) | ((c[2] & 255) << 16) | ((c[1] & 255) << 8) | (c[0] & 255)) >>> 0;
}

/** Draw a segment `t` pixels wide, centred on the line, into a w x h pixel buffer. */
export function strokeSeg(buf: Uint32Array, w: number, h: number, ax: number, ay: number, bx: number, by: number, c: number, t: number) {
  const dx = bx - ax, dy = by - ay;
  const flat = Math.abs(dx) >= Math.abs(dy);
  const n = Math.max(1, Math.ceil(flat ? Math.abs(dx) : Math.abs(dy)));
  for (let i = 0; i <= n; i++) {
    const x = ax + (dx * i) / n, y = ay + (dy * i) / n;
    const px = flat ? Math.floor(x) : Math.round(x - t / 2), py = flat ? Math.round(y - t / 2) : Math.floor(y);
    for (let j = 0; j < t; j++) {
      const qx = flat ? px : px + j, qy = flat ? py + j : py;
      if (qx >= 0 && qy >= 0 && qx < w && qy < h) buf[qy * w + qx] = c;
    }
  }
}

/** Pixel buffer for procedural sprites. */
export class Pix {
  readonly data: Uint32Array;
  constructor(readonly w: number, readonly h: number) {
    this.data = new Uint32Array(w * h);
  }
  set(x: number, y: number, c: number) {
    x |= 0; y |= 0;
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.data[y * this.w + x] = c;
  }
  get(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.data[y * this.w + x] : 0;
  }
  rect(x: number, y: number, w: number, h: number, c: number) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  /** Filled ellipse centred at (cx, cy). */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: number | ((x: number, y: number, nx: number, ny: number) => number)) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1) this.set(x, y, typeof c === 'number' ? c : c(x, y, nx, ny));
      }
    }
  }
  /** Dark outline around opaque pixels. */
  outline(c: number) {
    const src = this.data.slice();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (src[y * this.w + x] >>> 24) continue;
        const n = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < this.w && yy < this.h && (src[yy * this.w + xx] >>> 24) > 200;
        if (n(x - 1, y) || n(x + 1, y) || n(x, y - 1) || n(x, y + 1)) this.data[y * this.w + x] = c;
      }
    }
  }
  toCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(this.w, this.h);
    new Uint32Array(img.data.buffer).set(this.data);
    ctx.putImageData(img, 0, 0);
    return c;
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/** Point in polygon (flat [x0, y0, x1, y1, ...]). */
export function inPoly(x: number, y: number, p: ArrayLike<number>): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
