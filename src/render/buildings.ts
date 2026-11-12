import { PPM, VSCALE } from '../config';
import type { Building, Kind } from '../data';
import type { Season } from '../season';
import { canvas, css, hash2, hex, inPoly, mix, rng, shade, type RGB } from '../util';

export const FLOOR = Math.round(3.3 * PPM * VSCALE);

interface Wall {
  path: Path2D;
  x1: number; y1: number; x2: number; y2: number;
  slope: number;
  /** Extra darkness for walls turned away from the light (upper left). */
  dark: number;
  len: number;
}

export interface Sign {
  /** World texels, sign board rectangle. */
  x: number; y: number; w: number; h: number;
  text: string;
  color: string;
}

export interface BuildingGeo {
  b: Building;
  /** Wall height in texels. */
  ht: number;
  walls: Wall[];
  roof: Path2D;
  boxes: Array<{ x: number; y: number; w: number; d: number; h: number }>;
  door: { x: number; y: number } | null;
  sign: Sign | null;
  wall: RGB;
  roofColor: RGB;
  solar: boolean;
  /** Roof drawn from the official render: image and its box at ground level, world texels. */
  tex: { img: HTMLCanvasElement; x: number; y: number; w: number; h: number } | null;
  /** Screen-space bounds in world texels (roof included). */
  sx0: number; sx1: number; sy0: number; sy1: number;
}

const WALLS: Record<Kind, string[]> = {
  teach: ['#dcd8cf', '#e3d6bd', '#cfc9bf', '#d9cbb3'],
  dorm: ['#d7b48f', '#cfa47f', '#e0cdb0', '#c99a78'],
  home: ['#d8c8ad', '#cbb89d', '#e2d6c0', '#c2a88f'],
  hall: ['#ecebe6', '#e4e0d6'],
  tower: ['#9fb3c3', '#a8bccb'],
  canteen: ['#e3caa2', '#dcc39c'],
  roof: ['#b9b4aa'],
  misc: ['#cdc7bb', '#d6d0c4', '#c4bdb0'],
};

const SIGN: Record<Kind, string> = {
  teach: '#2f5d9e', dorm: '#3d7d4a', home: '#6b5a44', hall: '#a33b32', tower: '#2f4f6e',
  canteen: '#b86a1f', roof: '#555', misc: '#4b5563',
};

const BAY: Record<Kind, number> = { teach: 48, dorm: 40, home: 44, hall: 64, tower: 32, canteen: 56, roof: 48, misc: 48 };

/** One repeating facade tile: 3 bays x 2 floors so lit windows vary at night. */
function facade(kind: Kind, wall: RGB, night: boolean, seed: number): HTMLCanvasElement {
  const bay = BAY[kind];
  const [c, ctx] = canvas(bay * 3, FLOOR * 2);
  const r = rng(seed);
  ctx.fillStyle = css(wall);
  ctx.fillRect(0, 0, c.width, c.height);
  // wall grain
  for (let i = 0; i < c.width * c.height * 0.05; i++) {
    ctx.fillStyle = css(shade(wall, r() < 0.5 ? 0.95 : 1.04));
    ctx.fillRect((r() * c.width) | 0, (r() * c.height) | 0, 1, 1);
  }
  const glassDay = hex('#6f8ea8'), glassHi = hex('#9cb8cc'), glassDark = hex('#2d3b52');
  const lit = hex('#ffd77a'), litHi = hex('#fff1c2');
  const frame = shade(wall, 0.72);
  for (let f = 0; f < 2; f++) {
    const fy = f * FLOOR;
    // slab line between floors
    ctx.fillStyle = css(shade(wall, 0.88));
    ctx.fillRect(0, fy + FLOOR - 1, c.width, 1);
    if (kind === 'roof') {
      for (let b = 0; b < 3; b++) {
        ctx.fillStyle = css(shade(wall, 0.55));
        ctx.fillRect(b * bay + 6, fy + 4, bay - 12, FLOOR - 6);
      }
      continue;
    }
    if (kind === 'tower') {
      for (let b = 0; b < 3; b++) {
        const on = night && r() < 0.5;
        ctx.fillStyle = css(on ? lit : night ? glassDark : glassDay);
        ctx.fillRect(b * bay + 1, fy + 2, bay - 2, FLOOR - 9);
        ctx.fillStyle = css(on ? litHi : glassHi);
        if (!night || on) ctx.fillRect(b * bay + 3, fy + 3, 3, FLOOR - 12);
        ctx.fillStyle = css(shade(wall, 0.8));
        ctx.fillRect(b * bay + bay / 2, fy + 2, 1, FLOOR - 9);
      }
      continue;
    }
    const ww = kind === 'hall' ? 40 : kind === 'canteen' ? 40 : kind === 'teach' ? 22 : kind === 'misc' ? 16 : 18;
    const wh = kind === 'hall' ? 26 : kind === 'canteen' ? 20 : kind === 'misc' ? 14 : 17;
    for (let b = 0; b < 3; b++) {
      const x = b * bay + ((bay - ww) >> 1), y = fy + Math.max(4, ((FLOOR - wh) >> 1) - 2);
      const on = night && r() < 0.42;
      ctx.fillStyle = css(frame);
      ctx.fillRect(x - 1, y - 1, ww + 2, wh + 2);
      ctx.fillStyle = css(on ? lit : night ? glassDark : glassDay);
      ctx.fillRect(x, y, ww, wh);
      if (!night || on) {
        ctx.fillStyle = css(on ? litHi : glassHi);
        ctx.fillRect(x + 1, y + 1, Math.max(2, ww >> 3), wh - 2);
        ctx.fillRect(x + 1, y + 1, ww - 2, 1);
      }
      // mullion and sill
      ctx.fillStyle = css(frame);
      ctx.fillRect(x + (ww >> 1), y, 1, wh);
      ctx.fillStyle = css(shade(wall, 1.1));
      ctx.fillRect(x - 2, y + wh + 1, ww + 4, 2);
      if (kind === 'dorm' && b !== 1) {
        // air conditioner box next to the window
        ctx.fillStyle = '#eceae4';
        ctx.fillRect(x + ww + 3, y + wh - 6, 6, 6);
        ctx.fillStyle = '#9c9a94';
        ctx.fillRect(x + ww + 4, y + wh - 5, 4, 1);
        ctx.fillRect(x + ww + 4, y + wh - 3, 4, 1);
      }
      if (kind === 'home') {
        ctx.fillStyle = css(shade(wall, 0.8));
        ctx.fillRect(x - 3, y + wh - 5, ww + 6, 6);
        ctx.fillStyle = css(shade(wall, 1.12));
        ctx.fillRect(x - 3, y + wh - 6, ww + 6, 1);
      }
    }
  }
  return c;
}

function roofDefault(kind: Kind): RGB {
  return hex(kind === 'dorm' ? '#b7b2a8' : kind === 'hall' ? '#c9c4bb' : '#bdb9b1');
}

export class Buildings {
  geo: BuildingGeo[];
  private patterns = new Map<string, CanvasPattern>();
  private grain: CanvasPattern | null = null;
  private solarPat: CanvasPattern | null = null;
  night = false;

  private roofTex: Array<BuildingGeo['tex']>;

  /** `roofs`: the official render of the roofs, `res` pixels per metre. */
  constructor(list: Building[], private season: Season, roofs: ImageBitmap, res: number) {
    this.roofTex = list.map((b) => {
      if (!b.tex) return null;
      const x = Math.floor(b.minx * res), y = Math.floor(b.miny * res);
      const [img, ctx] = canvas(Math.ceil(b.maxx * res) - x, Math.ceil(b.maxy * res) - y);
      ctx.drawImage(roofs, -x, -y);
      return { img, x: (x / res) * PPM, y: (y / res) * PPM, w: (img.width / res) * PPM, h: (img.height / res) * PPM };
    });
    this.geo = list.map((b) => this.make(b));
  }

  setSeason(season: Season) {
    this.season = season;
    this.geo = this.geo.map((g) => this.make(g.b));
  }

  private make(b: Building): BuildingGeo {
    const ht = Math.round(b.h * PPM * VSCALE);
    const variants = WALLS[b.kind];
    const wall = hex(variants[hash2(b.id, 7) % variants.length]);
    let roofColor = b.roof ? hex(b.roof) : roofDefault(b.kind);
    const solar = !!b.roof && roofColor[2] > roofColor[0] + 25 && roofColor[2] > 120;
    // official map roofs are rendered with AO; lift them a little toward a clean pixel palette
    roofColor = mix(roofColor, [roofColor[0] * 1.08, roofColor[1] * 1.08, roofColor[2] * 1.06], 0.6) as RGB;
    if (this.season === 'winter') roofColor = mix(roofColor, [238, 243, 246], 0.75);
    const rings = [b.p, ...b.holes];
    const walls: Wall[] = [];
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const x1 = ring[i * 2] * PPM, y1 = ring[i * 2 + 1] * PPM;
        const x2 = ring[((i + 1) % n) * 2] * PPM, y2 = ring[((i + 1) % n) * 2 + 1] * PPM;
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
        if (len < 1) continue;
        const nx = dy / len, ny = -dx / len; // outward normal (ring orientation fixed by the build script)
        if (ny < 0.06) continue;
        const path = new Path2D();
        path.moveTo(x1, y1); path.lineTo(x2, y2); path.lineTo(x2, y2 - ht); path.lineTo(x1, y1 - ht); path.closePath();
        walls.push({ path, x1, y1, x2, y2, slope: Math.abs(dx) > 0.01 ? dy / dx : 0, dark: Math.max(0, nx) * 0.22 + (1 - ny) * 0.08, len });
      }
    }
    walls.sort((a, c) => (a.y1 + a.y2) - (c.y1 + c.y2));
    const roof = new Path2D();
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i] * PPM, y = ring[i + 1] * PPM - ht;
        if (i === 0) roof.moveTo(x, y); else roof.lineTo(x, y);
      }
      roof.closePath();
    }
    // rooftop stair houses on larger roofs
    const boxes: BuildingGeo['boxes'] = [];
    const area = (b.maxx - b.minx) * (b.maxy - b.miny);
    const tex = this.roofTex[b.id];
    if (!tex && b.kind !== 'roof' && area > 260) {
      const r = rng(b.id * 31 + 5);
      const tries = area > 2500 ? 3 : area > 900 ? 2 : 1;
      for (let k = 0; k < tries * 4 && boxes.length < tries; k++) {
        const x = b.minx + (b.maxx - b.minx) * (0.25 + r() * 0.5), y = b.miny + (b.maxy - b.miny) * (0.25 + r() * 0.5);
        const w = 3 + r() * 3, d = 3 + r() * 2;
        if ([[x, y], [x + w, y], [x, y + d], [x + w, y + d]].every(([px, py]) => inPoly(px, py, b.p))) {
          boxes.push({ x: x * PPM, y: y * PPM - ht, w: w * PPM, d: d * PPM, h: Math.round(2.6 * PPM * VSCALE) });
        }
      }
    }
    // entrance: centre of the longest nearly horizontal south wall
    let door: BuildingGeo['door'] = null;
    let sign: Sign | null = null;
    if (b.name && b.kind !== 'roof') {
      let best: Wall | null = null;
      for (const w of walls) {
        if (Math.abs(w.slope) < 0.35 && w.len > 5 * PPM && (!best || w.len > best.len)) best = w;
      }
      if (best && ht > 30) {
        const x = Math.round((best.x1 + best.x2) / 2), y = Math.round((best.y1 + best.y2) / 2);
        door = { x, y };
        const text = b.name.length > 9 ? b.name.slice(0, 9) + '…' : b.name;
        const w = Math.min(best.len - 8, Math.max(44, text.length * 11 + 12));
        sign = { x: x - w / 2, y: y - Math.min(ht - 4, 56), w, h: 14, text, color: SIGN[b.kind] };
      }
    }
    let sy0 = Infinity;
    for (const bx of boxes) sy0 = Math.min(sy0, bx.y - bx.h);
    return {
      b, ht, walls, roof, boxes, door, sign, wall, roofColor, solar, tex,
      sx0: b.minx * PPM - 1, sx1: b.maxx * PPM + 1, sy0: Math.min(sy0, b.miny * PPM - ht) - 2, sy1: b.maxy * PPM + 4,
    };
  }

  private pattern(ctx: CanvasRenderingContext2D, g: BuildingGeo): CanvasPattern {
    const key = `${g.b.kind}|${g.wall.join()}|${this.night ? 1 : 0}`;
    let p = this.patterns.get(key);
    if (!p) {
      p = ctx.createPattern(facade(g.b.kind, g.wall, this.night, hash2(g.wall[0], g.wall[1])), 'repeat')!;
      this.patterns.set(key, p);
    }
    return p;
  }

  setNight(night: boolean) {
    if (night !== this.night) {
      this.night = night;
      this.patterns.clear();
    }
  }

  private extras(ctx: CanvasRenderingContext2D) {
    if (!this.grain) {
      const [c, x] = canvas(32, 32);
      const r = rng(99);
      for (let i = 0; i < 90; i++) {
        x.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.08)';
        x.fillRect((r() * 32) | 0, (r() * 32) | 0, 1 + ((r() * 2) | 0), 1);
      }
      this.grain = ctx.createPattern(c, 'repeat');
      const [s, sx] = canvas(12, 8);
      sx.fillStyle = '#2c4a7a'; sx.fillRect(0, 0, 12, 8);
      sx.fillStyle = '#3f67a3'; sx.fillRect(1, 1, 10, 3);
      sx.fillStyle = '#5a85c2'; sx.fillRect(1, 1, 10, 1);
      this.solarPat = ctx.createPattern(s, 'repeat');
    }
  }

  draw(ctx: CanvasRenderingContext2D, g: BuildingGeo) {
    this.extras(ctx);
    const pat = this.pattern(ctx, g);
    const m = new DOMMatrix();
    for (const w of g.walls) {
      // facade rows follow the wall base, so slanted walls get sheared windows
      m.a = 1; m.b = w.slope; m.c = 0; m.d = 1; m.e = w.x1; m.f = w.y1;
      pat.setTransform(m);
      ctx.fillStyle = pat;
      ctx.fill(w.path);
      if (w.dark > 0.01) {
        ctx.fillStyle = `rgba(20,24,40,${w.dark.toFixed(3)})`;
        ctx.fill(w.path);
      }
      // plinth and corner lines
      ctx.strokeStyle = 'rgba(40,36,30,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w.x1, w.y1 - 1); ctx.lineTo(w.x2, w.y2 - 1);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(40,36,30,0.35)';
      ctx.beginPath();
      ctx.moveTo(w.x1 + 0.5, w.y1); ctx.lineTo(w.x1 + 0.5, w.y1 - g.ht);
      ctx.moveTo(w.x2 - 0.5, w.y2); ctx.lineTo(w.x2 - 0.5, w.y2 - g.ht);
      ctx.stroke();
      // cornice
      ctx.strokeStyle = css(shade(g.wall, 1.12));
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w.x1, w.y1 - g.ht + 1); ctx.lineTo(w.x2, w.y2 - g.ht + 1);
      ctx.stroke();
    }
    if (g.door) this.drawDoor(ctx, g);
    // roof
    ctx.fillStyle = css(g.roofColor);
    ctx.fill(g.roof, 'evenodd');
    if (g.tex) {
      ctx.save();
      ctx.clip(g.roof, 'evenodd');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(g.tex.img, g.tex.x, g.tex.y - g.ht, g.tex.w, g.tex.h);
      if (this.season === 'winter') {
        ctx.fillStyle = 'rgba(238,243,246,0.7)';
        ctx.fill(g.roof, 'evenodd');
      }
      ctx.restore();
    } else if (g.solar && this.season !== 'winter') {
      ctx.save();
      ctx.clip(g.roof, 'evenodd');
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = this.solarPat!;
      ctx.fill(g.roof, 'evenodd');
      ctx.restore();
    }
    if (!g.tex) {
      ctx.fillStyle = this.grain!;
      ctx.fill(g.roof, 'evenodd');
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = css(shade(g.roofColor, 0.72));
    ctx.stroke(g.roof);
    ctx.lineWidth = 1;
    ctx.strokeStyle = css(shade(g.roofColor, 1.15));
    ctx.save();
    ctx.translate(1, 1);
    ctx.stroke(g.roof);
    ctx.restore();
    for (const bx of g.boxes) {
      const top = bx.y - bx.h;
      ctx.fillStyle = css(shade(g.wall, 0.92));
      ctx.fillRect(bx.x, top + bx.d, bx.w, bx.h);
      ctx.fillStyle = css(shade(g.roofColor, 1.05));
      ctx.fillRect(bx.x, top, bx.w, bx.d);
      ctx.fillStyle = css(shade(g.roofColor, 0.7));
      ctx.fillRect(bx.x, top + bx.d - 1, bx.w, 1);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(bx.x + bx.w, top + bx.d + 2, 4, bx.h - 2);
      ctx.fillStyle = '#5a6b7c';
      ctx.fillRect(bx.x + (bx.w >> 1) - 5, top + bx.d + bx.h - 16, 10, 14);
    }
  }

  private drawDoor(ctx: CanvasRenderingContext2D, g: BuildingGeo) {
    const { x, y } = g.door!;
    const s = g.sign!;
    ctx.fillStyle = '#cfcac0';
    ctx.fillRect(x - 26, y - 2, 52, 5);
    ctx.fillStyle = '#b2ada3';
    ctx.fillRect(x - 26, y + 2, 52, 1);
    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(x - 19, y - 32, 38, 30);
    ctx.fillStyle = this.night ? '#f2d488' : '#5d7d96';
    ctx.fillRect(x - 17, y - 30, 16, 28);
    ctx.fillRect(x + 1, y - 30, 16, 28);
    ctx.fillStyle = this.night ? '#fff0c4' : '#8eaec4';
    ctx.fillRect(x - 15, y - 29, 2, 26);
    ctx.fillRect(x + 3, y - 29, 2, 26);
    ctx.fillStyle = '#c8c3b8';
    ctx.fillRect(x - 3, y - 18, 2, 6);
    ctx.fillRect(x + 1, y - 18, 2, 6);
    // canopy
    ctx.fillStyle = '#ece9e2';
    ctx.fillRect(x - 25, y - 38, 50, 6);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x - 25, y - 32, 50, 2);
    // name board (text is drawn on the HUD at native resolution)
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(s.x - 1, s.y - 1, s.w + 2, s.h + 2);
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(s.x, s.y, s.w, 1);
  }
}

/** Largest footprint y crossed by the vertical line at x (metres), or -Infinity. */
export function footMaxY(b: Building, x: number): number {
  let best = -Infinity;
  for (const ring of [b.p, ...b.holes]) {
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const x1 = ring[j], y1 = ring[j + 1], x2 = ring[i], y2 = ring[i + 1];
      if ((x1 <= x && x2 >= x) || (x2 <= x && x1 >= x)) {
        const y = x1 === x2 ? Math.max(y1, y2) : y1 + ((x - x1) * (y2 - y1)) / (x2 - x1);
        if (y > best) best = y;
      }
    }
  }
  return best;
}
