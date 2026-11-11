import { G } from './config';

export type Kind = 'dorm' | 'home' | 'hall' | 'canteen' | 'tower' | 'teach' | 'roof' | 'misc';

export interface Building {
  id: number;
  name: string;
  kind: Kind;
  /** Height in metres. */
  h: number;
  floors: number;
  roof: string | null;
  /** Outer ring, metres, clockwise on screen. */
  p: Float32Array;
  holes: Float32Array[];
  campus: boolean;
  minx: number; maxx: number; miny: number; maxy: number;
  cx: number; cy: number;
}

export interface Label { t: string; x: number; y: number; c?: string }

export interface World {
  w: number;
  h: number;
  res: number;
  gw: number;
  gh: number;
  /** Ground class per cell; painted lines are split out into `lines`. */
  ground: Uint8Array;
  /** Painted line cells: bit 0 left, 1 right, 2 up, 3 down neighbour is also a line, bit 4 = line. */
  lines: Uint8Array;
  buildings: Building[];
  /** Trees as parallel arrays: x, y metres, radius metres, kind. */
  tx: Float32Array; ty: Float32Array; tr: Float32Array; tk: Uint8Array;
  labels: Label[];
  gates: Label[];
  roads: Label[];
  campus: Float32Array;
  origin: { lon0: number; lat0: number; mx: number; my: number; x0: number; y0: number };
}

// palette written by tools/build_map.py (DEBUG_COLORS)
const PALETTE: Array<[number, number, number, G]> = [
  [112, 178, 72, G.Grass], [150, 150, 146, G.Pave], [66, 66, 72, G.Asph], [186, 82, 62, G.Red],
  [62, 150, 66, G.Turf], [64, 98, 196, G.Blue], [52, 118, 210, G.Water], [214, 212, 204, G.LPave],
  [245, 245, 245, G.Line], [186, 182, 172, G.Urban], [200, 196, 186, G.Sidewalk], [160, 128, 88, G.Dirt],
];

function decimetres(a: number[]): Float32Array {
  const f = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) f[i] = a[i] / 10;
  return f;
}

interface RawLabel { t: string; x: number; y: number; c?: string }
/** Shape of public/data/campus.json as written by tools/build_map.py. */
interface RawCampus {
  size: [number, number];
  res: number;
  origin: World['origin'];
  campus: number[];
  buildings: Array<{ n: string; k: Kind; h: number; f: number; roof?: string; p: number[]; holes?: number[][]; campus: boolean }>;
  trees: number[];
  labels: RawLabel[];
  gates: RawLabel[];
  roads: RawLabel[];
}

export async function loadWorld(urls: { campus: string; ground: string }, onProgress?: (p: number) => void): Promise<World> {
  const [json, png] = await Promise.all([
    // our own build output, served with the app
    fetch(urls.campus).then((r) => r.json() as Promise<RawCampus>),
    fetch(urls.ground).then((r) => r.blob()),
  ]);
  onProgress?.(0.6);
  const bmp = await createImageBitmap(png, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const gw = bmp.width, gh = bmp.height;
  const c = document.createElement('canvas');
  c.width = gw;
  c.height = gh;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const px = new Uint32Array(ctx.getImageData(0, 0, gw, gh).data.buffer);
  bmp.close();
  const lut = new Map<number, number>();
  for (const [r, g, b, k] of PALETTE) lut.set((b << 16) | (g << 8) | r, k);
  const ground = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i++) ground[i] = lut.get(px[i] & 0xffffff) ?? G.Pave;
  const lines = splitLines(ground, gw, gh);
  c.width = c.height = 0;
  onProgress?.(0.85);

  const buildings: Building[] = json.buildings.map((b, id) => {
    const p = decimetres(b.p);
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, sx = 0, sy = 0;
    for (let i = 0; i < p.length; i += 2) {
      minx = Math.min(minx, p[i]); maxx = Math.max(maxx, p[i]);
      miny = Math.min(miny, p[i + 1]); maxy = Math.max(maxy, p[i + 1]);
      sx += p[i]; sy += p[i + 1];
    }
    return {
      id, name: b.n, kind: b.k, h: b.h, floors: b.f, roof: b.roof ?? null, p,
      holes: (b.holes ?? []).map(decimetres), campus: b.campus,
      minx, maxx, miny, maxy, cx: sx / (p.length / 2), cy: sy / (p.length / 2),
    };
  });
  const t = json.trees;
  const n = t.length / 4;
  const tx = new Float32Array(n), ty = new Float32Array(n), tr = new Float32Array(n), tk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    tx[i] = t[i * 4] / 10; ty[i] = t[i * 4 + 1] / 10; tr[i] = t[i * 4 + 2] / 10; tk[i] = t[i * 4 + 3];
  }
  const lab = (l: RawLabel): Label => ({ ...l, x: l.x / 10, y: l.y / 10 });
  return {
    w: json.size[0], h: json.size[1], res: json.res, gw, gh, lines,
    ground, buildings, tx, ty, tr, tk,
    labels: json.labels.map(lab), gates: json.gates.map(lab), roads: json.roads.map(lab),
    campus: decimetres(json.campus), origin: json.origin,
  };
}

/** Move G.Line cells into a flag layer and give them the surrounding surface underneath. */
function splitLines(ground: Uint8Array, gw: number, gh: number): Uint8Array {
  const lines = new Uint8Array(ground.length);
  const isLine = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < gh && ground[y * gw + x] === G.Line;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (ground[y * gw + x] !== G.Line) continue;
      lines[y * gw + x] = 16 | (isLine(x - 1, y) ? 1 : 0) | (isLine(x + 1, y) ? 2 : 0) | (isLine(x, y - 1) ? 4 : 0) | (isLine(x, y + 1) ? 8 : 0);
    }
  }
  const counts = new Uint16Array(16);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (!lines[i]) continue;
      counts.fill(0);
      for (let r = 1; r <= 3; r++) {
        for (const [dx, dy] of [[-r, 0], [r, 0], [0, -r], [0, r], [-r, -r], [r, r], [-r, r], [r, -r]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
          const g = ground[yy * gw + xx];
          if (g !== G.Line) counts[g]++;
        }
      }
      let best = G.Pave, bc = 0;
      for (let k = 1; k < 16; k++) if (counts[k] > bc) { bc = counts[k]; best = k; }
      ground[i] = best;
    }
  }
  return lines;
}

/** Ground class at a world position in metres. */
export function groundAt(w: World, x: number, y: number): number {
  const gx = (x * w.res) | 0, gy = (y * w.res) | 0;
  if (gx < 0 || gy < 0 || gx >= w.gw || gy >= w.gh) return G.None;
  return w.ground[gy * w.gw + gx];
}

/** WGS-84 to world metres. */
export function lonLatToWorld(w: World, lon: number, lat: number): [number, number] {
  const o = w.origin;
  return [(lon - o.lon0) * o.mx - o.x0, -(lat - o.lat0) * o.my - o.y0];
}
