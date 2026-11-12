import { CHUNK, OV_PPM, PPM, VSCALE } from '../config';
import type { Building, Label, Prop, World } from '../data';
import { css, hash2, inPoly } from '../util';
import { Buildings, footMaxY } from './buildings';
import { CH, drawChar, frameOf } from './chars';
import { GroundCache } from './ground';
import { TreeSprites } from './trees';
import type { Season } from '../season';

export interface Actor {
  id: number;
  name: string;
  look: number;
  x: number;
  y: number;
  dir: number;
  moving: boolean;
  running: boolean;
  animT: number;
  chat: { text: string; until: number } | null;
  me?: boolean;
}

export interface Poi {
  t: string;
  x: number;
  y: number;
  kind: 'poi' | 'gate' | 'parking';
  building: Building | null;
}

interface Item {
  key: number;
  type: 0 | 1 | 2 | 3 | 4 | 5; // building, tree, actor, fence, post, prop
  i: number;
  x0: number; x1: number; y0: number; y1: number; // screen box in world texels
  fx: number; fy: number; // foot point (metres) for occlusion tests
  alpha?: number;
}

const TREE_BUCKET = 16; // metres

export class View {
  readonly ground: GroundCache;
  readonly buildings: Buildings;
  readonly trees: TreeSprites;
  pois: Poi[];
  private treeGrid = new Map<number, number[]>();
  private fence: Array<[number, number, number, number]> = [];
  private layer: CanvasRenderingContext2D | null = null;
  tint: [number, number, number] = [255, 255, 255];
  night = 0;
  /** Signs and labels to draw on the HUD after the frame. */
  hudSigns: Array<{ x: number; y: number; w: number; text: string }> = [];

  constructor(readonly world: World, season: Season) {
    this.ground = new GroundCache(world, season);
    this.buildings = new Buildings(world.buildings, season, world.roofs, world.res);
    this.trees = new TreeSprites(season);
    for (let i = 0; i < world.tx.length; i++) {
      const k = Math.floor(world.ty[i] / TREE_BUCKET) * 1000 + Math.floor(world.tx[i] / TREE_BUCKET);
      let a = this.treeGrid.get(k);
      if (!a) this.treeGrid.set(k, (a = []));
      a.push(i);
    }
    this.pois = [];
    const inside = (x: number, y: number) =>
      world.buildings.find((b) => x >= b.minx && x <= b.maxx && y >= b.miny && y <= b.maxy && inPoly(x, y, b.p)) ?? null;
    for (const l of world.labels) {
      this.pois.push({ t: l.t, x: l.x, y: l.y, kind: l.c === 'P' ? 'parking' : 'poi', building: inside(l.x, l.y) });
    }
    const gateSeen: Label[] = [];
    for (const g of world.gates) {
      if (gateSeen.some((o) => Math.hypot(o.x - g.x, o.y - g.y) < 10)) continue;
      gateSeen.push(g);
      this.pois.push({ t: g.t, x: g.x, y: g.y, kind: 'gate', building: null });
    }
    // fence segments along the campus boundary, gaps at gates
    const cp = world.campus, n = cp.length / 2;
    for (let i = 0; i < n; i++) {
      const x1 = cp[i * 2], y1 = cp[i * 2 + 1], x2 = cp[((i + 1) % n) * 2], y2 = cp[((i + 1) % n) * 2 + 1];
      const segs = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / 2.5));
      for (let s = 0; s < segs; s++) {
        const ax = x1 + ((x2 - x1) * s) / segs, ay = y1 + ((y2 - y1) * s) / segs;
        const bx = x1 + ((x2 - x1) * (s + 1)) / segs, by = y1 + ((y2 - y1) * (s + 1)) / segs;
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        if (world.gates.some((g) => (g.x - mx) ** 2 + (g.y - my) ** 2 < 49)) continue;
        if (inside(mx, my)) continue;
        this.fence.push([ax * PPM, ay * PPM, bx * PPM, by * PPM]);
      }
    }
  }

  setSeason(s: Season) {
    this.ground.setSeason(s);
    this.buildings.setSeason(s);
    this.trees.setSeason(s);
  }

  /**
   * Walk view. `ctx` is the texel canvas (tw x th), camera top-left at (camX, camY) world texels.
   */
  drawWorld(ctx: CanvasRenderingContext2D, tw: number, th: number, camX: number, camY: number, actors: Actor[], me: Actor | null) {
    const w = this.world;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#2b2b33';
    ctx.fillRect(0, 0, tw, th);
    ctx.setTransform(1, 0, 0, 1, -camX, -camY);

    // ground chunks
    const c0 = Math.max(0, Math.floor(camX / CHUNK)), c1 = Math.min(this.ground.cols - 1, Math.floor((camX + tw) / CHUNK));
    const r0 = Math.max(0, Math.floor(camY / CHUNK)), r1 = Math.min(this.ground.rows - 1, Math.floor((camY + th) / CHUNK));
    let missing = 0;
    for (let cy = r0; cy <= r1; cy++) {
      for (let cx = c0; cx <= c1; cx++) {
        const ch = this.ground.get(cx, cy);
        if (ch) ctx.drawImage(ch, cx * CHUNK, cy * CHUNK);
        else {
          missing++;
          ctx.fillStyle = '#7a9a5a';
          ctx.fillRect(cx * CHUNK, cy * CHUNK, CHUNK, CHUNK);
        }
      }
    }
    this.ground.retain((cx, cy) => cx >= c0 - 1 && cx <= c1 + 1 && cy >= r0 - 1 && cy <= r1 + 1);
    this.ground.max = Math.max(48, (c1 - c0 + 3) * (r1 - r0 + 3) + 8);
    this.ground.pump(missing ? 40 : 6, missing ? 1 : 0);
    // prefetch the ring around the view
    if (!missing) {
      for (let cy = r0 - 1; cy <= r1 + 1; cy++) for (let cx = c0 - 1; cx <= c1 + 1; cx++) {
        if (cx >= 0 && cy >= 0 && cx < this.ground.cols && cy < this.ground.rows) this.ground.get(cx, cy);
      }
    }

    // collect sortable items
    const vx0 = camX - 8, vx1 = camX + tw + 8, vy0 = camY - 8, vy1 = camY + th + 8;
    const items: Item[] = [];
    const geos = this.buildings.geo;
    const visB: number[] = [];
    for (let i = 0; i < geos.length; i++) {
      const g = geos[i];
      if (g.sx1 < vx0 || g.sx0 > vx1 || g.sy1 < vy0 || g.sy0 > vy1) continue;
      visB.push(i);
      items.push({ key: g.b.maxy, type: 0, i, x0: g.sx0, x1: g.sx1, y0: g.sy0, y1: g.sy1, fx: 0, fy: 0 });
    }
    const bx0 = Math.floor(vx0 / PPM / TREE_BUCKET) - 1, bx1 = Math.floor(vx1 / PPM / TREE_BUCKET) + 1;
    const by0 = Math.floor(vy0 / PPM / TREE_BUCKET) - 1, by1 = Math.floor(vy1 / PPM / TREE_BUCKET) + 2;
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const a = this.treeGrid.get(by * 1000 + bx);
        if (!a) continue;
        for (const i of a) {
          const s = this.trees.get(w.tk[i], w.tr[i], i);
          const x = w.tx[i] * PPM, y = w.ty[i] * PPM;
          const x0 = x - s.ax, y0 = y - s.ay;
          if (x0 > vx1 || x0 + s.img.width < vx0 || y0 > vy1 || y0 + s.img.height < vy0) continue;
          items.push({ key: w.ty[i], type: 1, i, x0, x1: x0 + s.img.width, y0, y1: y0 + s.img.height, fx: w.tx[i], fy: w.ty[i] });
        }
      }
    }
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      const x = a.x * PPM, y = a.y * PPM;
      if (x < vx0 - 20 || x > vx1 + 20 || y < vy0 || y > vy1 + CH + 20) continue;
      items.push({ key: a.y, type: 2, i, x0: x - 9, x1: x + 9, y0: y - CH - 2, y1: y + 2, fx: a.x, fy: a.y });
    }
    for (let i = 0; i < this.fence.length; i++) {
      const [ax, ay, bx, by] = this.fence[i];
      const x0 = Math.min(ax, bx) - 2, x1 = Math.max(ax, bx) + 2, y0 = Math.min(ay, by) - 22, y1 = Math.max(ay, by) + 2;
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
      items.push({ key: Math.max(ay, by) / PPM, type: 3, i, x0, x1, y0, y1, fx: (ax + bx) / 2 / PPM, fy: Math.max(ay, by) / PPM });
    }
    for (let i = 0; i < this.pois.length; i++) {
      const p = this.pois[i];
      if (p.building) continue;
      const x = p.x * PPM, y = p.y * PPM;
      if (x < vx0 - 20 || x > vx1 + 20 || y < vy0 || y > vy1 + 30) continue;
      items.push({ key: p.y, type: 4, i, x0: x - 14, x1: x + 14, y0: y - 26, y1: y + 2, fx: p.x, fy: p.y });
    }

    for (let i = 0; i < w.props.length; i++) {
      const p = w.props[i];
      const x0 = p.x * PPM - 4, x1 = (p.x + p.w) * PPM + 4, y0 = p.y * PPM - 40, y1 = (p.y + p.d) * PPM + 2;
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
      items.push({ key: p.y + p.d, type: 5, i, x0, x1, y0, y1, fx: p.x + p.w / 2, fy: p.y + p.d });
    }

    // sprites standing south of a building's footprint (at their x) go in front of it even if the
    // building reaches further south elsewhere (L-shapes, courtyards)
    for (const it of items) {
      if (it.type === 0) continue;
      let inFront = false, bump = -Infinity;
      for (const bi of visB) {
        const g = geos[bi];
        if (g.sx1 < it.x0 || g.sx0 > it.x1 || g.sy1 < it.y0 || g.sy0 > it.y1) continue;
        if (g.b.maxy <= it.key) continue;
        const hw = (it.x1 - it.x0) / 2 / PPM * 0.6;
        const fm = Math.max(footMaxY(g.b, it.fx - hw), footMaxY(g.b, it.fx), footMaxY(g.b, it.fx + hw));
        if (fm > it.fy - 0.05) { inFront = true; break; }
        bump = Math.max(bump, g.b.maxy);
      }
      if (!inFront && bump > -Infinity) it.key = bump + 0.001;
    }
    items.sort((a, b) => a.key - b.key || a.type - b.type);

    // trees and buildings standing in front of the local player turn see-through
    let meItem: Item | undefined;
    if (me) meItem = items.find((it) => it.type === 2 && actors[it.i] === me);
    if (meItem) {
      for (const it of items) {
        if (it.key <= meItem.key || it === meItem) continue;
        const overlap = it.x0 < meItem.x1 && it.x1 > meItem.x0 && it.y0 < meItem.y1 - 4 && it.y1 > meItem.y0;
        if (!overlap) continue;
        if (it.type === 1) it.alpha = 0.45;
        if (it.type === 0) it.alpha = 0.5;
      }
    }

    this.hudSigns.length = 0;
    for (const it of items) {
      switch (it.type) {
        case 0: {
          const g = geos[it.i];
          if (it.alpha) {
            // composite the whole building at once so its own walls do not show through each other
            const lc = this.layerCtx(tw, th);
            lc.setTransform(1, 0, 0, 1, -camX, -camY);
            this.buildings.draw(lc, g);
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = it.alpha;
            ctx.drawImage(lc.canvas, 0, 0);
            ctx.restore();
            lc.setTransform(1, 0, 0, 1, 0, 0);
            lc.clearRect(0, 0, tw, th);
          } else this.buildings.draw(ctx, g);
          if (g.sign) this.hudSigns.push({ x: g.sign.x + g.sign.w / 2, y: g.sign.y + g.sign.h / 2, w: g.sign.w, text: g.sign.text });
          break;
        }
        case 1: {
          const s = this.trees.get(w.tk[it.i], w.tr[it.i], it.i);
          if (it.alpha) ctx.globalAlpha = it.alpha;
          ctx.drawImage(s.img, Math.round(it.x0), Math.round(it.y0));
          ctx.globalAlpha = 1;
          break;
        }
        case 2:
          this.drawActor(ctx, actors[it.i]);
          break;
        case 3:
          this.drawFence(ctx, this.fence[it.i]);
          break;
        case 4:
          this.drawPost(ctx, this.pois[it.i]);
          break;
        case 5:
          drawProp(ctx, w.props[it.i], it.i);
          break;
      }
    }
    // light
    if (this.night > 0.02) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = css(this.tint);
      ctx.fillRect(0, 0, tw, th);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  private layerCtx(w: number, h: number): CanvasRenderingContext2D {
    if (!this.layer) this.layer = document.createElement('canvas').getContext('2d')!;
    const c = this.layer.canvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      this.layer.imageSmoothingEnabled = false;
    }
    return this.layer;
  }

  private drawActor(ctx: CanvasRenderingContext2D, a: Actor) {
    const x = a.x * PPM, y = a.y * PPM;
    ctx.fillStyle = 'rgba(20,24,20,0.32)';
    ctx.beginPath();
    ctx.ellipse(Math.round(x), Math.round(y), 6, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    drawChar(ctx, a.look, a.dir, frameOf(a.moving, a.animT, a.running), x, y);
  }

  private drawFence(ctx: CanvasRenderingContext2D, f: [number, number, number, number]) {
    const [ax, ay, bx, by] = f;
    ctx.strokeStyle = '#2f3a36';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const hgt of [6, 15]) { ctx.moveTo(ax, ay - hgt); ctx.lineTo(bx, by - hgt); }
    ctx.stroke();
    // pickets
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 5));
    ctx.fillStyle = '#34413c';
    for (let k = 0; k < n; k++) {
      const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
      ctx.fillRect(Math.round(x), Math.round(y - 17), 1, 17);
    }
    ctx.fillStyle = '#5d6d66';
    ctx.fillRect(Math.round(ax) - 1, Math.round(ay - 20), 3, 20);
    ctx.fillStyle = '#7c8d86';
    ctx.fillRect(Math.round(ax) - 1, Math.round(ay - 21), 3, 1);
  }

  private drawPost(ctx: CanvasRenderingContext2D, p: Poi) {
    const x = Math.round(p.x * PPM), y = Math.round(p.y * PPM);
    if (p.kind === 'gate') {
      for (const dx of [-60, 56]) {
        ctx.fillStyle = '#8c8577';
        ctx.fillRect(x + dx, y - 34, 6, 34);
        ctx.fillStyle = '#b3ab9c';
        ctx.fillRect(x + dx, y - 36, 6, 3);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x + dx + 6, y - 2, 4, 3);
      }
      return;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x - 3, y - 1, 8, 2);
    ctx.fillStyle = '#6b4a32';
    ctx.fillRect(x - 1, y - 16, 2, 16);
    const color = p.kind === 'parking' ? '#2563eb' : '#8a5a2b';
    ctx.fillStyle = '#3a2a20';
    ctx.fillRect(x - 9, y - 25, 18, 11);
    ctx.fillStyle = color;
    ctx.fillRect(x - 8, y - 24, 16, 9);
    ctx.fillStyle = '#fff';
    if (p.kind === 'parking') {
      ctx.fillRect(x - 2, y - 23, 1, 7); ctx.fillRect(x - 1, y - 23, 3, 1); ctx.fillRect(x + 2, y - 22, 1, 2); ctx.fillRect(x - 1, y - 20, 3, 1);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(x - 6, y - 22, 12, 1); ctx.fillRect(x - 6, y - 19, 9, 1);
    }
  }

  /** Overview map: `scale` CSS px per metre, centred on (mx, my). */
  drawOverview(ctx: CanvasRenderingContext2D, ov: HTMLCanvasElement, cw: number, chh: number, dpr: number, mx: number, my: number, scale: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2b2b33';
    ctx.fillRect(0, 0, cw * dpr, chh * dpr);
    const k = (scale * dpr) / OV_PPM;
    const ox = cw * dpr / 2 - mx * scale * dpr, oy = chh * dpr / 2 - my * scale * dpr;
    ctx.imageSmoothingEnabled = k < 1;
    ctx.setTransform(k, 0, 0, k, Math.round(ox), Math.round(oy));
    ctx.drawImage(ov, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  /** Roof label anchor for a building (metres, shifted up by the drawn height in the overview). */
  static roofAnchor(b: Building): [number, number] {
    return [b.cx, b.cy - (b.h * VSCALE * 0.9)];
  }
}

const BIKE = ['#c0392b', '#2f6db5', '#e0b030', '#3d8a4f', '#5b5f66', '#d9d9d9'];

/** Small things from the official map, drawn inside their box (metres) in world texels. */
function drawProp(ctx: CanvasRenderingContext2D, p: Prop, seed: number) {
  const x0 = Math.round(p.x * PPM), y0 = Math.round(p.y * PPM), w = Math.round(p.w * PPM), d = Math.round(p.d * PPM);
  const rect = (c: string, x: number, y: number, ww: number, hh: number) => { ctx.fillStyle = c; ctx.fillRect(x, y, ww, hh); };
  switch (p.k) {
    case 'bikes': {
      // rows of parked bikes seen from above, handlebars up
      for (let y = y0 + 12; y <= y0 + Math.max(d, 12); y += 30) {
        for (let x = x0 + 2, n = 0; x + 5 <= x0 + Math.max(w, 7); x += 9, n++) {
          if (hash2(n, y, seed) % 5 === 0) continue;
          rect('rgba(0,0,0,0.22)', x + 1, y - 1, 5, 2);
          rect('#26282c', x + 1, y - 12, 2, 4);
          rect('#26282c', x + 1, y - 3, 2, 4);
          rect(BIKE[hash2(n, y, seed + 1) % BIKE.length], x + 1, y - 9, 2, 7);
          rect('#1c1d20', x, y - 6, 4, 2);
          rect('#8f949b', x - 1, y - 10, 6, 1);
        }
      }
      break;
    }
    case 'lockers': {
      const along = w >= d;
      for (let k = 0; k < Math.max(1, Math.floor((along ? w : d) / PPM)); k++) {
        const x = along ? x0 + k * PPM : x0, y = along ? y0 + d : y0 + (k + 1) * PPM;
        rect('#d8dadc', x, y - 30, PPM, 30);
        rect('#e9772b', x, y - 32, PPM, 4);
        rect('#aeb2b6', x + PPM - 1, y - 28, 1, 28);
        for (let r = 1; r < 4; r++) rect('#aeb2b6', x, y - 28 + r * 7, PPM, 1);
      }
      break;
    }
    case 'table': {
      // one table-tennis table, top raised above its shadow, net across the middle
      const y = y0 + d, top = y - 9 - d;
      rect('rgba(0,0,0,0.2)', x0 + 2, y - 3, w, 4);
      rect('#4b4f55', x0 + 2, y - 9, 2, 9); rect('#4b4f55', x0 + w - 4, y - 9, 2, 9);
      rect('#1f5fa8', x0, top, w, d);
      rect('#f1f1ec', x0, top, w, 1); rect('#f1f1ec', x0, top + d - 1, w, 1); rect('#f1f1ec', x0, top, 1, d); rect('#f1f1ec', x0 + w - 1, top, 1, d);
      if (w >= d) { rect('#f1f1ec', x0, top + (d >> 1), w, 1); rect('#dfe3e6', x0 + (w >> 1) - 1, top - 3, 2, d + 3); }
      else { rect('#f1f1ec', x0 + (w >> 1), top, 1, d); rect('#dfe3e6', x0, top + (d >> 1) - 3, w, 3); }
      break;
    }
    case 'cage': {
      // a frame of steel bars: posts, top rails, and the rails across
      const y = y0 + d, hgt = 40, bar = '#2f4fa8', far = '#243c82';
      for (let x = x0; x <= x0 + w; x += Math.max(8, Math.round(w / Math.max(1, Math.round(w / 40))))) {
        rect(far, x, y0 - hgt, 2, hgt);
        rect(far, x, y0 - hgt, 2, d);
      }
      rect(far, x0, y0 - hgt, w + 2, 2);
      for (let yy = y0 + 24; yy < y; yy += 24) rect(bar, x0, yy - hgt, w + 2, 2);
      for (let x = x0; x <= x0 + w; x += Math.max(8, Math.round(w / Math.max(1, Math.round(w / 40))))) rect(bar, x, y - hgt, 2, hgt);
      rect(bar, x0, y - hgt, w + 2, 2);
      break;
    }
    case 'statue': {
      const x = x0 + (w >> 1), y = y0 + d;
      rect('rgba(0,0,0,0.25)', x - 9, y - 1, 20, 3);
      rect('#b9b4a8', x - 8, y - 12, 16, 12);
      rect('#d2cdc2', x - 8, y - 13, 16, 2);
      rect('#7a5a36', x - 4, y - 34, 8, 22);
      rect('#96703f', x - 4, y - 34, 3, 22);
      rect('#7a5a36', x - 3, y - 40, 6, 6);
      break;
    }
    case 'rock': {
      const x = x0 + (w >> 1), y = y0 + d;
      rect('rgba(0,0,0,0.25)', x - 12, y - 1, 26, 3);
      rect('#8d8f8c', x - 11, y - 12, 22, 12);
      rect('#a7a9a5', x - 8, y - 18, 15, 7);
      rect('#bfc1bc', x - 6, y - 18, 6, 3);
      rect('#74767a', x + 6, y - 9, 5, 9);
      break;
    }
  }
}
