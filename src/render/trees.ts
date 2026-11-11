import { PPM, VSCALE } from '../config';
import type { Season } from '../season';
import { hex, pack, Pix, rng, shade, type RGB } from '../util';

/** Tree kinds from the build script: 0 deciduous, 1 ginkgo, 2 maple, 3 evergreen. */
export const SIZES = [1.6, 2.3, 3.0];

export interface TreeSprite {
  img: HTMLCanvasElement;
  /** Anchor (trunk base) inside the image. */
  ax: number;
  ay: number;
  /** Canopy box relative to the anchor, for see-through checks. */
  top: number;
  half: number;
}

type Tones = [RGB, RGB, RGB, RGB]; // dark, mid, light, highlight

function tones(kind: number, season: Season, variant: number): Tones | null {
  const t = (a: string, b: string, c: string, d: string): Tones => [hex(a), hex(b), hex(c), hex(d)];
  if (kind === 3) return t('#1f4a2c', '#2d6339', '#3f7d47', '#5b9a5a');
  switch (season) {
    case 'spring':
      if (kind === 0 && variant === 1) return t('#c46a8c', '#e391b0', '#f4b9cf', '#fde3ec'); // blossom
      return kind === 1 ? t('#5d9a3c', '#7bb84e', '#9cd36a', '#c3e98f') : t('#3f7f36', '#58a043', '#76bb56', '#9fd77a');
    case 'summer':
      return kind === 1 ? t('#3f7a32', '#58993f', '#73b553', '#96cf71') : t('#2c6630', '#3f823b', '#579f4a', '#7cbd62');
    case 'autumn':
      if (kind === 1) return t('#b8861a', '#dcae27', '#f2cd45', '#fde58a');
      if (kind === 2) return t('#8f2c1f', '#bf4a26', '#e0702f', '#f3a258');
      return variant === 1 ? t('#8a6a22', '#b38f2e', '#cfb046', '#e7d27a') : t('#4f6a2a', '#6c8735', '#8ea445', '#b7c466');
    case 'winter':
      return null;
  }
}

function makeTree(kind: number, season: Season, size: number, variant: number): TreeSprite {
  const r = rng(kind * 1000 + Math.round(size * 10) * 10 + variant);
  const R = Math.round(size * PPM * 0.8);
  const Ry = Math.round(R * 0.86);
  const trunkH = Math.round((1.3 + size * 0.25) * PPM * VSCALE);
  const W = R * 2 + 6, H = Ry * 2 + trunkH + 10;
  const p = new Pix(W, H);
  const cx = W / 2, cy = Ry + 3;
  const ay = cy + Ry + trunkH - 4;
  // ground shadow
  const sh = pack([20, 30, 20], 70);
  p.ellipse(cx, ay, R * 0.7, Math.max(3, R * 0.22), sh);
  const bark: RGB = hex('#6b4a32'), barkD: RGB = hex('#4a3222'), barkL: RGB = hex('#8a6446');
  const tw = Math.max(3, Math.round(R * 0.16));
  for (let y = cy; y <= ay; y++) {
    for (let x = -tw; x <= tw; x++) {
      const c = x < -tw / 3 ? barkL : x > tw / 3 ? barkD : bark;
      p.set(cx + x, y, pack(c));
    }
  }
  const tn = tones(kind, season, variant);
  if (!tn) {
    // winter: bare branches with a dusting of snow
    const snow = pack(hex('#f3f7f9'));
    const branch = (x: number, y: number, ang: number, len: number, w: number) => {
      for (let i = 0; i < len; i++) {
        const bx = x + Math.cos(ang) * i, by = y - Math.sin(ang) * i;
        for (let k = 0; k < w; k++) p.set(bx + k, by, pack(k === 0 ? barkL : bark));
        if (i % 3 === 0) p.set(bx, by - 1, snow);
        if (w > 1 && i > len * 0.4 && r() < 0.12) branch(bx, by, ang + (r() - 0.5) * 1.6, len * 0.45, w - 1);
      }
    };
    const top = cy + Ry * 0.3;
    for (let k = 0; k < 5; k++) branch(cx, top, Math.PI / 2 + (k - 2) * 0.42 + (r() - 0.5) * 0.2, R * (0.7 + r() * 0.3), 2);
    p.outline(pack(hex('#3a2a20'), 160));
    return { img: p.toCanvas(), ax: Math.round(cx), ay: Math.round(ay), top: ay - cy + Ry, half: R };
  }
  const [dark, mid, light, hi] = tn.map((c) => pack(c));
  if (kind === 3) {
    // layered conifer
    const tiers = 4;
    for (let t = 0; t < tiers; t++) {
      const ty = cy - Ry + ((t + 1) * (Ry * 2)) / tiers;
      const tr = R * (0.45 + (t / tiers) * 0.55);
      for (let y = Math.round(ty - Ry * 0.7); y <= ty; y++) {
        const span = tr * ((y - (ty - Ry * 0.7)) / (Ry * 0.7));
        for (let x = -Math.round(span); x <= Math.round(span); x++) {
          const u = x / (span + 1);
          const n = ((x * 7 + y * 13) & 3) === 0;
          p.set(cx + x, y, u < -0.45 ? (n ? hi : light) : u > 0.35 ? dark : n ? light : mid);
        }
      }
    }
    if (season === 'winter') p.rect(cx - 2, cy - Ry, 4, 2, pack(hex('#f3f7f9')));
  } else {
    // round canopy built from lumps; light from the upper left
    const blobs: Array<[number, number, number]> = [[cx, cy, R * 0.78]];
    const nb = 7 + ((r() * 3) | 0);
    for (let k = 0; k < nb; k++) {
      const a = (k / nb) * Math.PI * 2 + r() * 0.5;
      const d = R * (0.42 + r() * 0.12);
      blobs.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.86, R * (0.36 + r() * 0.12)]);
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let inside = false, best = -1e9, bx = 0, by = 0, br = 1;
        for (const [ox, oy, rr] of blobs) {
          const dx = x + 0.5 - ox, dy = (y + 0.5 - oy) / 0.86;
          const d = (dx * dx + dy * dy) / (rr * rr);
          if (d <= 1) {
            inside = true;
            // shade with the lump nearest the viewer (lowest on screen)
            const front = oy + rr * 0.2;
            if (front > best) { best = front; bx = ox; by = oy; br = rr; }
          }
        }
        if (!inside) continue;
        const nx = (x + 0.5 - bx) / br, ny = (y + 0.5 - by) / br;
        const gx = (x + 0.5 - cx) / R, gy = (y + 0.5 - cy) / Ry;
        let l = -nx * 0.45 - ny * 0.6 - gx * 0.35 - gy * 0.55;
        l += ((((x >> 1) * 73 + (y >> 1) * 151) & 7) - 3.5) * 0.06; // leaf clusters
        p.set(x, y, l > 0.62 ? hi : l > 0.12 ? light : l > -0.42 ? mid : dark);
      }
    }
    if (season === 'autumn' && kind !== 3) {
      // a few fallen leaves around the trunk
      for (let k = 0; k < 6; k++) p.set(cx + (r() - 0.5) * R * 1.4, ay - 2 + (r() - 0.5) * 6, light);
    }
  }
  p.outline(pack(shade(tn[0], 0.6)));
  return { img: p.toCanvas(), ax: Math.round(cx), ay: Math.round(ay), top: ay - cy + Ry, half: R };
}

export class TreeSprites {
  private cache = new Map<number, TreeSprite>();
  constructor(private season: Season) {}

  setSeason(season: Season) {
    this.season = season;
    this.cache.clear();
  }

  get(kind: number, radius: number, seed: number): TreeSprite {
    let si = 0;
    for (let i = 1; i < SIZES.length; i++) if (Math.abs(SIZES[i] - radius) < Math.abs(SIZES[si] - radius)) si = i;
    const variant = seed & 1;
    const key = kind * 100 + si * 10 + variant;
    let s = this.cache.get(key);
    if (!s) {
      s = makeTree(kind, this.season, SIZES[si], variant);
      this.cache.set(key, s);
    }
    return s;
  }
}
