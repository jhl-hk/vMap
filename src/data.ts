import { CHUNK, G, PPM } from './config';
import { hex, pack } from './util';

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
  /** The roof is drawn from the official render. */
  tex: boolean;
  minx: number; maxx: number; miny: number; maxy: number;
  cx: number; cy: number;
}

/** A small outlined thing: its kind and its box in metres. */
export interface Prop { k: 'bikes' | 'statue' | 'rock' | 'table' | 'cage' | 'lockers'; x: number; y: number; w: number; d: number }

export interface Label { t: string; x: number; y: number; c?: string }

export interface World {
  w: number;
  h: number;
  res: number;
  gw: number;
  gh: number;
  /** Ground class per cell. */
  ground: Uint8Array;
  /** Painted line segments: x1, y1, x2, y2 in metres, widest first; each has a style. */
  segs: Float32Array;
  segStyle: Uint8Array;
  /** Packed colour and width in texels. */
  styles: Array<{ color: number; w: number }>;
  /** Segment numbers by ground chunk, keyed cy * 4096 + cx. */
  segChunks: Map<number, number[]>;
  buildings: Building[];
  /** Trees as parallel arrays: x, y metres, radius metres, kind. */
  tx: Float32Array; ty: Float32Array; tr: Float32Array; tk: Uint8Array;
  labels: Label[];
  gates: Label[];
  roads: Label[];
  props: Prop[];
  /** Official render of the roofs on the ground grid; closed once the buildings have cut their pieces. */
  roofs: ImageBitmap;
  campus: Float32Array;
  /** `turn`: rotation of the world axes from east and south, radians. */
  origin: { lon0: number; lat0: number; mx: number; my: number; turn: number; x0: number; y0: number };
}

// palette written by tools/build_map.py (DEBUG_COLORS)
const PALETTE: Array<[number, number, number, G]> = [
  [112, 178, 72, G.Grass], [150, 150, 146, G.Pave], [66, 66, 72, G.Asph], [186, 82, 62, G.Red],
  [62, 150, 66, G.Turf], [64, 98, 196, G.Blue], [52, 118, 210, G.Water], [214, 212, 204, G.LPave],
  [186, 182, 172, G.Urban], [200, 196, 186, G.Sidewalk], [160, 128, 88, G.Dirt],
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
  buildings: Array<{ n: string; k: Kind; h: number; f: number; roof?: string; p: number[]; holes?: number[][]; campus: boolean; tex?: boolean }>;
  props: Prop[];
  lines: Array<{ c: string; w: number; l: number[][] }>;
  trees: number[];
  labels: RawLabel[];
  gates: RawLabel[];
  roads: RawLabel[];
}

export async function loadWorld(urls: { campus: string; ground: string; roofs: string }, onProgress?: (p: number) => void): Promise<World> {
  const [json, png, roofs] = await Promise.all([
    // our own build output, served with the app
    fetch(urls.campus).then((r) => r.json() as Promise<RawCampus>),
    fetch(urls.ground).then((r) => r.blob()),
    fetch(urls.roofs).then((r) => r.blob()).then((b) => createImageBitmap(b)),
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
      holes: (b.holes ?? []).map(decimetres), campus: b.campus, tex: !!b.tex,
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
    w: json.size[0], h: json.size[1], res: json.res, gw, gh, ...decodeLines(json.lines), roofs,
    props: json.props.map((p) => ({ k: p.k, x: p.x / 10, y: p.y / 10, w: p.w / 10, d: p.d / 10 })),
    ground, buildings, tx, ty, tr, tk,
    labels: json.labels.map(lab), gates: json.gates.map(lab), roads: json.roads.map(lab),
    campus: decimetres(json.campus), origin: json.origin,
  };
}

/** Painted lines: steps of 1/20 m after the first vertex become segments in metres, indexed by ground chunk. */
function decodeLines(groups: RawCampus['lines']): Pick<World, 'segs' | 'segChunks' | 'segStyle' | 'styles'> {
  const count = groups.reduce((n, g) => n + g.l.reduce((m, l) => m + l.length / 2 - 1, 0), 0);
  const segs = new Float32Array(count * 4), segStyle = new Uint8Array(count);
  const segChunks = new Map<number, number[]>();
  const styles = groups.map((g) => ({ color: pack(hex('#' + g.c)), w: g.w }));
  const size = CHUNK / PPM;
  let k = 0;
  groups.forEach((g, gi) => {
    const m = (g.w / 2 + 1) / PPM; // half the stroke and a texel, in metres
    for (const l of g.l) {
      let x = l[0], y = l[1];
      for (let i = 2; i < l.length; i += 2) {
        const nx = x + l[i], ny = y + l[i + 1];
        segs.set([x / 20, y / 20, nx / 20, ny / 20], k * 4);
        segStyle[k] = gi;
        const cx1 = Math.floor((Math.max(x, nx) / 20 + m) / size), cy1 = Math.floor((Math.max(y, ny) / 20 + m) / size);
        for (let cy = Math.max(0, Math.floor((Math.min(y, ny) / 20 - m) / size)); cy <= cy1; cy++) {
          for (let cx = Math.max(0, Math.floor((Math.min(x, nx) / 20 - m) / size)); cx <= cx1; cx++) {
            const key = cy * 4096 + cx;
            const a = segChunks.get(key);
            if (a) a.push(k); else segChunks.set(key, [k]);
          }
        }
        x = nx; y = ny; k++;
      }
    }
  });
  return { segs, segChunks, segStyle, styles };
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
  const x = (lon - o.lon0) * o.mx, y = -(lat - o.lat0) * o.my;
  const c = Math.cos(o.turn), s = Math.sin(o.turn);
  return [c * x - s * y - o.x0, s * x + c * y - o.y0];
}
