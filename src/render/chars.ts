import { hex, pack, Pix } from '../util';

export const CW = 16;
export const CH = 24;

export const SKIN = ['#f6d3b3', '#ecbf98', '#d6a078', '#ad764e'];
export const HAIR = ['#1e1a1a', '#3b2a20', '#5e3b24', '#8a5a2b', '#c9a15a', '#d9d2c8', '#8e3434', '#2e3f6e'];
export const TOPS = [
  '#004ea2', '#e8e6e1', '#2b2d33', '#c83a3a', '#3d8b4a', '#f0c23a', '#8b5cc4', '#ef7d9a',
  '#f08a3c', '#5aa9c9', '#7b5a3c', '#9aa3ad', '#1d3d6e', '#b8334a', '#6aa84f', '#2f6fb3',
];
export const BOTTOMS = ['#2b3a55', '#1f1f24', '#6b6f78', '#c9b28f', '#3b4f3a', '#5a3d2b', '#e8e6e1', '#7a2e2e'];
export const SHOES = ['#f2f2f2', '#2a2a2a', '#8a5a2b', '#c83a3a'];
export const BAGS = ['', '#2a2a2a', '#2f6fb3', '#c83a3a'];
export const HAIR_STYLES = ['短发', '长发', '丸子头', '波波头', '刺猬头', '帽子'];

export interface Look { skin: number; style: number; hair: number; top: number; bottom: number; shoes: number; bag: number }

export function encodeLook(l: Look): number {
  return ((l.skin & 3) | ((l.style & 7) << 2) | ((l.hair & 7) << 5) | ((l.top & 15) << 8) |
    ((l.bottom & 7) << 12) | ((l.shoes & 3) << 15) | ((l.bag & 3) << 17)) >>> 0;
}

export function decodeLook(v: number): Look {
  return {
    skin: v & 3, style: Math.min((v >> 2) & 7, HAIR_STYLES.length - 1), hair: (v >> 5) & 7, top: (v >> 8) & 15,
    bottom: (v >> 12) & 7, shoes: (v >> 15) & 3, bag: (v >> 17) & 3,
  };
}

export function randomLook(): number {
  const r = (n: number) => Math.floor(Math.random() * n);
  return encodeLook({ skin: r(3), style: r(HAIR_STYLES.length), hair: r(5), top: r(16), bottom: r(8), shoes: r(4), bag: r(4) });
}

/** Directions: 0 down, 1 left, 2 right, 3 up. Frames: 0 idle, 1 step A, 2 step B. */
function drawFrame(p: Pix, ox: number, oy: number, l: Look, dir: number, frame: number) {
  const skin = pack(hex(SKIN[l.skin])), skinD = pack(shadeHex(SKIN[l.skin], 0.86));
  const hair = pack(hex(HAIR[l.hair])), hairL = pack(shadeHex(HAIR[l.hair], 1.35));
  const top = pack(hex(TOPS[l.top])), topD = pack(shadeHex(TOPS[l.top], 0.78));
  const bot = pack(hex(BOTTOMS[l.bottom])), botD = pack(shadeHex(BOTTOMS[l.bottom], 0.75));
  const shoe = pack(hex(SHOES[l.shoes]));
  const bag = l.bag ? pack(hex(BAGS[l.bag])) : 0, bagD = l.bag ? pack(shadeHex(BAGS[l.bag], 0.7)) : 0;
  const eye = pack(hex('#262226'));
  const R = (x: number, y: number, w: number, h: number, c: number) => p.rect(ox + x, oy + y, w, h, c);
  const side = dir === 1 || dir === 2;
  const mirror = dir === 2;
  const S = (x: number, y: number, w: number, h: number, c: number) => (mirror ? R(16 - x - w, y, w, h, c) : R(x, y, w, h, c));
  const lift = frame ? -1 : 0;

  // legs and shoes
  if (!side) {
    const la = frame === 1 ? -1 : 0, lb = frame === 2 ? -1 : 0;
    R(5, 17 + la, 3, 5, bot); R(8, 17 + lb, 3, 5, botD);
    R(5, 22 + la, 3, 2, shoe); R(8, 22 + lb, 3, 2, shoe);
  } else if (frame === 0) {
    S(6, 17, 4, 5, bot); S(6, 22, 5, 2, shoe);
  } else {
    const f = frame === 1 ? 1 : -1;
    S(6 - 2 * f, 17, 3, 5, bot); S(5 - 2 * f, 22, 4, 2, shoe);
    S(7 + 2 * f, 17, 3, 4, botD); S(7 + 2 * f, 21, 4, 2, shoe);
  }
  const y0 = lift;
  // torso
  if (!side) {
    R(4, 10 + y0, 8, 8, top);
    R(4, 16 + y0, 8, 1, topD);
    if (dir === 3 && bag) { R(5, 11 + y0, 6, 6, bag); R(5, 16 + y0, 6, 1, bagD); }
    const sa = frame === 1 ? 1 : frame === 2 ? -1 : 0;
    R(3, 10 + y0 + sa, 1, 6, topD); R(12, 10 + y0 - sa, 1, 6, topD);
    R(3, 16 + y0 + sa, 1, 1, skin); R(12, 16 + y0 - sa, 1, 1, skin);
    if (dir === 0 && bag) { R(4, 10 + y0, 1, 5, bagD); R(11, 10 + y0, 1, 5, bagD); }
  } else {
    S(5, 10 + y0, 6, 8, top);
    if (bag) { S(10, 11 + y0, 3, 6, bag); S(12, 12 + y0, 1, 5, bagD); }
    const sw = frame === 1 ? -2 : frame === 2 ? 2 : 0;
    S(7 + sw, 11 + y0, 2, 5, topD); S(7 + sw, 16 + y0, 2, 1, skin);
  }
  // head
  const hy = 2 + y0;
  if (!side) {
    R(4, hy + 1, 8, 7, skin); R(5, hy, 6, 1, skin); R(5, hy + 8, 6, 1, skinD);
  } else {
    S(5, hy + 1, 7, 7, skin); S(6, hy, 5, 1, skin); S(6, hy + 8, 5, 1, skinD); S(4, hy + 4, 1, 2, skin);
  }
  // hair
  const st = l.style;
  if (st === 5) {
    const cap = top, capD = topD;
    if (!side) { R(4, hy - 1, 8, 4, cap); R(dir === 0 ? 3 : 4, hy + 3, dir === 0 ? 10 : 8, 1, capD); }
    else { S(5, hy - 1, 7, 4, cap); S(2, hy + 3, 5, 1, capD); }
    if (dir === 3) R(4, hy + 3, 8, 3, hair);
  } else if (dir === 3) {
    R(4, hy, 8, st === 1 || st === 3 ? 9 : 6, hair);
    R(5, hy - 1, 6, 1, hair);
    if (st === 1) R(4, hy + 9, 8, 3, hair);
    if (st === 2) R(6, hy - 3, 4, 3, hair);
  } else if (!side) {
    R(4, hy - 1, 8, 3, hair); R(5, hy - 2 + (st === 4 ? 0 : 1), 6, 1, hair);
    R(4, hy + 2, 1, st === 3 ? 6 : 3, hair); R(11, hy + 2, 1, st === 3 ? 6 : 3, hair);
    R(6, hy - 1, 2, 1, hairL);
    if (st === 1) { R(3, hy + 2, 1, 9, hair); R(12, hy + 2, 1, 9, hair); R(4, hy + 5, 1, 5, hair); R(11, hy + 5, 1, 5, hair); }
    if (st === 2) R(6, hy - 4, 4, 3, hair);
    if (st === 4) for (let x = 4; x < 12; x += 2) R(x, hy - 3, 1, 1, hair);
  } else {
    S(5, hy - 1, 7, 3, hair); S(9, hy + 2, 3, st === 3 ? 6 : 4, hair); S(6, hy - 2, 5, 1, hair);
    S(7, hy - 1, 2, 1, hairL);
    if (st === 1) S(10, hy + 2, 3, 10, hair);
    if (st === 2) S(10, hy - 3, 3, 3, hair);
    if (st === 4) { S(6, hy - 3, 1, 1, hair); S(9, hy - 3, 1, 1, hair); }
  }
  // face
  if (dir === 0) {
    R(6, hy + 4, 1, 2, eye); R(9, hy + 4, 1, 2, eye);
    R(5, hy + 6, 1, 1, pack(hex('#f2a3a3'))); R(10, hy + 6, 1, 1, pack(hex('#f2a3a3')));
  } else if (side) {
    S(6, hy + 4, 1, 2, eye);
  }
}

function shadeHex(c: string, k: number): [number, number, number] {
  const [r, g, b] = hex(c);
  return [Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k)];
}

const sheets = new Map<number, HTMLCanvasElement>();

/** Sprite sheet for a look: 3 frames across, 4 directions down. */
export function charSheet(look: number): HTMLCanvasElement {
  let s = sheets.get(look);
  if (s) return s;
  const l = decodeLook(look);
  const p = new Pix(CW * 3 + 6, CH * 4 + 8);
  // each frame gets a 2 px gutter so outlines never bleed into neighbours
  for (let dir = 0; dir < 4; dir++) {
    for (let f = 0; f < 3; f++) {
      const sub = new Pix(CW + 2, CH + 2);
      drawFrame(sub, 1, 1, l, dir, f);
      sub.outline(pack(hex('#1b1b22'), 210));
      for (let y = 0; y < sub.h; y++) for (let x = 0; x < sub.w; x++) {
        const c = sub.get(x, y);
        if (c) p.set(f * (CW + 2) + x, dir * (CH + 2) + y, c);
      }
    }
  }
  s = p.toCanvas();
  sheets.set(look, s);
  if (sheets.size > 200) sheets.delete(sheets.keys().next().value!);
  return s;
}

/** Walk cycle: idle, A, idle, B. */
export function frameOf(moving: boolean, t: number, running: boolean): number {
  if (!moving) return 0;
  const step = Math.floor(t * (running ? 10 : 6.5)) & 3;
  return step === 1 ? 1 : step === 3 ? 2 : 0;
}

/** Draw a character with its feet at (x, y) texels. */
export function drawChar(ctx: CanvasRenderingContext2D, look: number, dir: number, frame: number, x: number, y: number) {
  const s = charSheet(look);
  ctx.drawImage(s, frame * (CW + 2), dir * (CH + 2), CW + 2, CH + 2, Math.round(x - (CW + 2) / 2), Math.round(y - CH - 1), CW + 2, CH + 2);
}
