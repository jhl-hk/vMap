import { G, OV_PPM, VSCALE } from '../config';
import type { World } from '../data';
import type { Season } from '../season';
import { css, hash2, hex, mix, pack, shade, type RGB } from '../util';
import type { Buildings } from './buildings';

const BASE: Record<number, string> = {
  [G.None]: '#2b2b33', [G.Grass]: '#6aa845', [G.Pave]: '#a9a69e', [G.Asph]: '#55575d', [G.Red]: '#b5533e',
  [G.Turf]: '#52a248', [G.Blue]: '#3f6bb8', [G.Water]: '#3f80c6', [G.LPave]: '#cfcbc0', [G.Line]: '#f1f1ec',
  [G.Urban]: '#b9b4a8', [G.Sidewalk]: '#c6bfb0', [G.Dirt]: '#a3825a',
};

const TREE_TOP: Record<Season, string[]> = {
  spring: ['#58a043', '#7bb84e', '#58a043', '#2d6339'],
  summer: ['#3f823b', '#58993f', '#3f823b', '#2d6339'],
  autumn: ['#7d9238', '#dcae27', '#c4552a', '#2d6339'],
  winter: ['#8a7a6a', '#8a7a6a', '#8a7a6a', '#2d6339'],
};

/** Whole-campus map at OV_PPM texels per metre: ground, trees, extruded buildings. */
export function buildOverview(w: World, season: Season, buildings: Buildings): HTMLCanvasElement {
  const W = Math.ceil(w.w * OV_PPM), H = Math.ceil(w.h * OV_PPM);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const px = new Uint32Array(img.data.buffer);
  const pal: number[][] = [];
  for (const k of Object.keys(BASE)) {
    let base = hex(BASE[+k]);
    if (season === 'winter' && +k === G.Grass) base = hex('#dfe7ea');
    if (season === 'autumn' && +k === G.Grass) base = hex('#8aa347');
    pal[+k] = [0.94, 0.98, 1, 1.03].map((f) => pack(shade(base, f)));
  }
  const line = pack(hex('#eeeeea'));
  const sx = w.gw / W, sy = w.gh / H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gi = Math.floor(y * sy) * w.gw + Math.floor(x * sx);
      const g = w.ground[gi];
      px[y * W + x] = w.lines[gi] ? line : (pal[g] ?? pal[G.Pave])[hash2(x, y) & 3];
    }
  }
  ctx.putImageData(img, 0, 0);

  // trees, back to front
  const order = Array.from(w.ty.keys()).sort((a, b) => w.ty[a] - w.ty[b]);
  const tops = TREE_TOP[season].map(hex);
  for (const i of order) {
    const x = w.tx[i] * OV_PPM, y = w.ty[i] * OV_PPM, r = Math.max(1.5, w.tr[i] * OV_PPM * 0.85);
    const col = tops[w.tk[i]] ?? tops[0];
    ctx.fillStyle = 'rgba(20,30,20,0.35)';
    ctx.beginPath(); ctx.ellipse(x + 1, y + 1, r, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css(shade(col, 0.7));
    ctx.beginPath(); ctx.arc(x, y - r * 0.6, r + 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css(col);
    ctx.beginPath(); ctx.arc(x, y - r * 0.6, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css(mix(col, [255, 255, 230], 0.3));
    ctx.fillRect(Math.round(x - r * 0.45), Math.round(y - r * 1.15), Math.max(1, Math.round(r * 0.5)), 1);
  }

  // buildings, back to front, with short extruded walls
  const geos = buildings.geo.slice().sort((a, b) => a.b.maxy - b.b.maxy);
  for (const g of geos) {
    const b = g.b;
    const ht = Math.max(2, Math.round(b.h * OV_PPM * VSCALE * 0.9));
    const wallC: RGB = shade(g.wall, 0.82);
    for (const ring of [b.p, ...b.holes]) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const x1 = ring[i * 2] * OV_PPM, y1 = ring[i * 2 + 1] * OV_PPM;
        const x2 = ring[((i + 1) % n) * 2] * OV_PPM, y2 = ring[((i + 1) % n) * 2 + 1] * OV_PPM;
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 0.5 || -(x2 - x1) / len < 0.06) continue;
        const nx = (y2 - y1) / len;
        ctx.fillStyle = css(shade(wallC, 1 - Math.max(0, nx) * 0.18));
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - ht); ctx.lineTo(x1, y1 - ht); ctx.closePath();
        ctx.fill();
        // window rows
        ctx.strokeStyle = 'rgba(40,60,90,0.35)';
        ctx.lineWidth = 1;
        for (let f = 3; f < ht - 1; f += 3) {
          ctx.beginPath(); ctx.moveTo(x1, y1 - f); ctx.lineTo(x2, y2 - f); ctx.stroke();
        }
      }
    }
    ctx.beginPath();
    for (const ring of [b.p, ...b.holes]) {
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i] * OV_PPM, y = ring[i + 1] * OV_PPM - ht;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fillStyle = css(g.roofColor);
    ctx.fill('evenodd');
    ctx.strokeStyle = css(shade(g.roofColor, 0.7));
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  return c;
}
