import { CHUNK, G, PPM } from '../config';
import type { World } from '../data';
import type { Season } from '../season';
import { hash2, hex, pack, rng, shade, strokeSeg, type RGB } from '../util';

const T = 64; // texture size in texels (4 m)

type Tex = Uint32Array;

function noiseTex(base: RGB, spots: Array<[RGB, number]>, seed: number): Tex {
  const t = new Uint32Array(T * T);
  const r = rng(seed);
  for (let i = 0; i < T * T; i++) {
    let c = base;
    const v = r();
    let acc = 0;
    for (const [sc, p] of spots) {
      acc += p;
      if (v < acc) { c = sc; break; }
    }
    t[i] = pack(c);
  }
  return t;
}

function grassTex(season: Season): Tex {
  const pal: Record<Season, [string, string, string, string]> = {
    spring: ['#78b84c', '#679f3f', '#8fcb5e', '#5a8f36'],
    summer: ['#68a842', '#5a9439', '#7cbb51', '#4d8231'],
    autumn: ['#8fa548', '#7d903e', '#a3b257', '#6c7f37'],
    winter: ['#dfe7ea', '#c8d3d8', '#f2f6f7', '#9fae9a'],
  };
  const [b, d, l, tuft] = pal[season].map(hex);
  const t = noiseTex(b, [[d, 0.16], [l, 0.08]], 11);
  const r = rng(12);
  // tufts: little "v" shapes like hand-drawn grass
  for (let k = 0; k < 34; k++) {
    const x = (r() * T) | 0, y = (r() * T) | 0;
    const set = (dx: number, dy: number, c: RGB) => { t[((y + dy) & (T - 1)) * T + ((x + dx) & (T - 1))] = pack(c); };
    set(0, 0, tuft); set(2, 0, tuft); set(1, 1, tuft); set(1, -1, season === 'winter' ? tuft : l);
  }
  const extras: Record<Season, Array<[string, number]>> = {
    spring: [['#ffffff', 10], ['#f6c6d8', 10], ['#ffe066', 8]],
    summer: [['#ffffff', 3], ['#ffe066', 3]],
    autumn: [['#d99a2b', 14], ['#c4622d', 8], ['#e8c547', 12]],
    winter: [],
  };
  for (const [c, n] of extras[season]) {
    for (let k = 0; k < n; k++) {
      const x = (r() * T) | 0, y = (r() * T) | 0;
      t[y * T + x] = pack(hex(c));
      if (season === 'autumn') t[y * T + ((x + 1) & (T - 1))] = pack(shade(hex(c), 0.85));
    }
  }
  return t;
}

function bricks(base: RGB, grout: RGB, bw: number, bh: number, offset: boolean, seed: number, vary = 0.06): Tex {
  const t = new Uint32Array(T * T);
  const r = rng(seed);
  const tint = new Map<number, number>();
  for (let y = 0; y < T; y++) {
    const row = Math.floor(y / bh);
    const off = offset && row & 1 ? bw >> 1 : 0;
    for (let x = 0; x < T; x++) {
      const xx = (x + off) % T;
      const col = Math.floor(xx / bw);
      const key = row * 64 + col;
      if (!tint.has(key)) tint.set(key, 1 + (r() - 0.5) * 2 * vary);
      const gx = xx % bw === 0, gy = y % bh === 0;
      let c = gx || gy ? grout : shade(base, tint.get(key)!);
      if (!gx && !gy && r() < 0.05) c = shade(c, 0.94);
      if (!gx && !gy && (xx % bw === 1 || y % bh === 1)) c = shade(c, 1.05);
      t[y * T + x] = pack(c);
    }
  }
  return t;
}

function stripes(a: RGB, b: RGB, seed: number): Tex {
  const t = noiseTex(a, [[shade(a, 0.93), 0.12], [shade(a, 1.05), 0.06]], seed);
  for (let y = 0; y < T; y++) for (let x = T / 2; x < T; x++) if (t[y * T + x] === pack(a)) t[y * T + x] = pack(b);
  return t;
}

function waterTex(): Tex {
  const deep = hex('#3d7fc6'), mid = hex('#4b8fd3'), hi = hex('#8cc4ee');
  const t = noiseTex(deep, [[mid, 0.2]], 41);
  const r = rng(42);
  for (let k = 0; k < 22; k++) {
    const x = (r() * T) | 0, y = (r() * T) | 0, len = 2 + ((r() * 4) | 0);
    for (let i = 0; i < len; i++) t[y * T + ((x + i) & (T - 1))] = pack(hi);
  }
  return t;
}

export function buildTextures(season: Season): Tex[] {
  const tex: Tex[] = [];
  const snow = season === 'winter';
  tex[G.None] = noiseTex(hex('#2b2b33'), [], 1);
  tex[G.Grass] = grassTex(season);
  tex[G.Pave] = bricks(hex('#aaa79f'), hex('#8e8b84'), 16, 8, true, 21);
  tex[G.Asph] = noiseTex(hex('#505258'), [[hex('#5c5e64'), 0.12], [hex('#46484d'), 0.12], [hex('#676970'), 0.02]], 31);
  tex[G.Red] = noiseTex(hex('#b4523d'), [[hex('#a54a37'), 0.18], [hex('#c25f48'), 0.1]], 51);
  tex[G.Turf] = stripes(hex('#4f9d45'), hex('#5aac4f'), 61);
  tex[G.Blue] = noiseTex(hex('#3f6bb8'), [[hex('#3a62aa'), 0.15], [hex('#4a77c4'), 0.08]], 71);
  tex[G.Water] = waterTex();
  tex[G.LPave] = bricks(hex('#d0ccc1'), hex('#b8b4a9'), 32, 32, false, 81, 0.04);
  tex[G.Urban] = bricks(hex('#bcb7ab'), hex('#a7a296'), 48, 48, true, 91, 0.03);
  tex[G.Sidewalk] = bricks(hex('#c9c1b1'), hex('#b0a898'), 8, 8, false, 101, 0.05);
  tex[G.Dirt] = noiseTex(hex('#a3825a'), [[hex('#94754f'), 0.2], [hex('#b08f66'), 0.1]], 111);
  if (snow) {
    // swept paths stay grey, snow lingers in the joints
    const s = pack(hex('#eef3f5'));
    for (const k of [G.Pave, G.LPave, G.Urban, G.Sidewalk]) {
      const r = rng(k * 7);
      for (let i = 0; i < T * T; i++) if (r() < 0.06) tex[k][i] = s;
    }
  }
  return tex;
}

/** Surfaces that look raised (grass verges) get a lip shadow where they meet hard ground. */
const SOFT = new Uint8Array(16);
SOFT[G.Grass] = 1;
SOFT[G.Turf] = 1;
const HARD_LIGHT = new Uint8Array(16);
HARD_LIGHT[G.Pave] = 1;
HARD_LIGHT[G.LPave] = 1;
HARD_LIGHT[G.Sidewalk] = 1;
HARD_LIGHT[G.Urban] = 1;

export class GroundCache {
  private tex: Tex[];
  private cache = new Map<number, HTMLCanvasElement>();
  private queue: number[] = [];
  private img: ImageData;
  private buf: Uint32Array;
  private scratch: CanvasRenderingContext2D;
  readonly cols: number;
  readonly rows: number;
  max = 96;
  private snow: boolean;

  constructor(private world: World, season: Season) {
    this.tex = buildTextures(season);
    this.snow = season === 'winter';
    this.cols = Math.ceil((world.w * PPM) / CHUNK);
    this.rows = Math.ceil((world.h * PPM) / CHUNK);
    const c = document.createElement('canvas');
    c.width = c.height = CHUNK;
    this.scratch = c.getContext('2d')!;
    this.img = this.scratch.createImageData(CHUNK, CHUNK);
    this.buf = new Uint32Array(this.img.data.buffer);
  }

  setSeason(season: Season) {
    this.tex = buildTextures(season);
    this.snow = season === 'winter';
    this.cache.clear();
  }

  /** Cached chunk or null; missing chunks are queued for build. */
  get(cx: number, cy: number): HTMLCanvasElement | null {
    const key = cy * 4096 + cx;
    const c = this.cache.get(key);
    if (c) {
      this.cache.delete(key);
      this.cache.set(key, c); // LRU order
      return c;
    }
    if (!this.queue.includes(key)) this.queue.push(key);
    return null;
  }

  /** Build queued chunks for up to `budget` ms. Returns true when something was built. */
  pump(budget: number, force = 0): boolean {
    const t0 = performance.now();
    let built = 0;
    while (this.queue.length && (built < force || performance.now() - t0 < budget)) {
      const key = this.queue.shift()!;
      if (this.cache.has(key)) continue;
      this.cache.set(key, this.build(key % 4096, Math.floor(key / 4096)));
      built++;
      while (this.cache.size > this.max) {
        const old = this.cache.keys().next().value!;
        const cv = this.cache.get(old)!;
        cv.width = cv.height = 0;
        this.cache.delete(old);
      }
    }
    return built > 0;
  }

  /** Forget queued chunks that are no longer wanted. */
  retain(keep: (cx: number, cy: number) => boolean) {
    this.queue = this.queue.filter((k) => keep(k % 4096, Math.floor(k / 4096)));
  }

  private build(cx: number, cy: number): HTMLCanvasElement {
    const w = this.world, g = w.ground, gw = w.gw, gh = w.gh, tex = this.tex, buf = this.buf;
    const X0 = cx * CHUNK, Y0 = cy * CHUNK;
    const cell = Math.log2(PPM / w.res); // texels per ground cell, as a shift
    const cls = (X: number, Y: number) => {
      const gx = X >> cell, gy = Y >> cell;
      return gx < 0 || gy < 0 || gx >= gw || gy >= gh ? G.None : g[gy * gw + gx];
    };
    const lip = pack(hex(this.snow ? '#b9c6cc' : '#4a7a30'));
    const curbHi = pack(hex('#dad7cf'));
    const curbLo = pack(hex('#3d3f44'));
    for (let ty = 0; ty < CHUNK; ty++) {
      const Y = Y0 + ty;
      for (let tx = 0; tx < CHUNK; tx++) {
        const X = X0 + tx;
        // jitter sampling in 2x2 texel blocks: soft, hand-drawn looking class borders
        const h = hash2(X >> 1, Y >> 1, 3);
        const jx = (h & 3) - 1, jy = ((h >> 3) & 3) - 1;
        const c = cls(X + jx, Y + jy);
        let col = tex[c][((Y & 63) << 6) | (X & 63)];
        if (SOFT[c]) {
          if (!SOFT[cls(X + jx, Y + jy + 3)]) col = lip;
        } else if (c === G.Asph) {
          const up = cls(X + jx, Y + jy - 2);
          if (HARD_LIGHT[up]) col = curbLo;
        } else if (HARD_LIGHT[c]) {
          if (cls(X + jx, Y + jy + 2) === G.Asph) col = curbHi;
        }
        buf[(ty << 8) | tx] = col;
      }
    }
    // painted lines
    for (const k of w.segChunks.get(cy * 4096 + cx) ?? []) {
      const s = w.segs.subarray(k * 4, k * 4 + 4), st = w.styles[w.segStyle[k]];
      strokeSeg(buf, CHUNK, CHUNK, s[0] * PPM - X0, s[1] * PPM - Y0, s[2] * PPM - X0, s[3] * PPM - Y0, st.color, st.w);
    }
    this.scratch.putImageData(this.img, 0, 0);
    const out = document.createElement('canvas');
    out.width = out.height = CHUNK;
    out.getContext('2d')!.drawImage(this.scratch.canvas, 0, 0);
    return out;
  }
}
