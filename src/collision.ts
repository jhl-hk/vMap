import { G } from './config';
import type { World } from './data';

/** Blocking grid, 2 cells per metre (same grid as the ground raster). */
export class Collision {
  readonly res = 2;
  readonly gw: number;
  readonly gh: number;
  readonly grid: Uint8Array;

  constructor(w: World, gateRadius = 7) {
    const res = this.res;
    this.gw = Math.ceil(w.w * res);
    this.gh = Math.ceil(w.h * res);
    const c = document.createElement('canvas');
    c.width = this.gw;
    c.height = this.gh;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.scale(res, res);
    for (const b of w.buildings) {
      ctx.beginPath();
      for (const ring of [b.p, ...b.holes]) {
        for (let i = 0; i < ring.length; i += 2) {
          if (i === 0) ctx.moveTo(ring[i], ring[i + 1]); else ctx.lineTo(ring[i], ring[i + 1]);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
    }
    // campus fence with openings at gates
    ctx.lineWidth = 0.6;
    const cp = w.campus;
    const n = cp.length / 2;
    for (let i = 0; i < n; i++) {
      const x1 = cp[i * 2], y1 = cp[i * 2 + 1], x2 = cp[((i + 1) % n) * 2], y2 = cp[((i + 1) % n) * 2 + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 0.5));
      let open = false;
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
        if (w.gates.some((g) => (g.x - x) ** 2 + (g.y - y) ** 2 < gateRadius * gateRadius)) { open = false; continue; }
        if (!open) { ctx.moveTo(x, y); open = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.grid = new Uint8Array(this.gw * this.gh);
    // read back in strips to keep peak memory low on phones
    for (let y0 = 0; y0 < this.gh; y0 += 256) {
      const hgt = Math.min(256, this.gh - y0);
      const a = ctx.getImageData(0, y0, this.gw, hgt).data;
      for (let i = 0; i < this.gw * hgt; i++) if (a[i * 4 + 3] > 110) this.grid[y0 * this.gw + i] = 1;
    }
    c.width = c.height = 0;
    if (w.gw === this.gw) {
      for (let i = 0; i < this.grid.length; i++) if (w.ground[i] === G.Water) this.grid[i] = 2;
    }
    // tree trunks
    for (let i = 0; i < w.tx.length; i++) {
      const x = Math.floor(w.tx[i] * res), y = Math.floor(w.ty[i] * res - 0.2);
      if (x >= 0 && y >= 0 && x < this.gw && y < this.gh) this.grid[y * this.gw + x] = 3;
    }
  }

  blocked(x: number, y: number): boolean {
    const gx = Math.floor(x * this.res), gy = Math.floor(y * this.res);
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return true;
    return this.grid[gy * this.gw + gx] !== 0;
  }

  /** Feet box of a walker: 0.5 m wide, 0.3 m deep. */
  boxBlocked(x: number, y: number): boolean {
    return this.blocked(x - 0.22, y - 0.28) || this.blocked(x + 0.22, y - 0.28) || this.blocked(x - 0.22, y) ||
      this.blocked(x + 0.22, y);
  }

  /** Move with axis-separated sliding; returns the new position. */
  move(x: number, y: number, dx: number, dy: number): [number, number] {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.1));
    const sx = dx / steps, sy = dy / steps;
    for (let i = 0; i < steps; i++) {
      if (!this.boxBlocked(x + sx, y)) x += sx;
      if (!this.boxBlocked(x, y + sy)) y += sy;
    }
    return [x, y];
  }

  /** Nearest free spot around (x, y), searching outward. */
  free(x: number, y: number): [number, number] {
    if (!this.boxBlocked(x, y)) return [x, y];
    for (let r = 0.5; r < 80; r += 0.5) {
      for (let a = 0; a < 24; a++) {
        const px = x + Math.cos((a / 24) * Math.PI * 2) * r, py = y + Math.sin((a / 24) * Math.PI * 2) * r;
        if (!this.boxBlocked(px, py)) return [px, py];
      }
    }
    return [x, y];
  }
}
