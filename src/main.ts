import { NAME_MAX, cleanText } from '../shared/protocol.js';
import { Collision } from './collision';
import { OV_PPM, PPM, RUN, STORAGE_KEY, VSCALE, WALK } from './config';
import { loadWorld, lonLatToWorld, type Building, type World } from './data';
import { Input, type Mode } from './input';
import { Net, type Remote } from './net';
import { CH, randomLook } from './render/chars';
import { buildOverview } from './render/overview';
import { View, type Actor, type Poi } from './render/view';
import { beijingNow, daylight, SEASON_NAME, seasonOf, type Season } from './season';
import { $, closeSheet, el, initSheet, openSheet, settingsSheet, toast, type Profile } from './ui';
import { clamp, inPoly } from './util';

declare const __CAMPUS_URL__: string;
declare const __GROUND_URL__: string;
declare const __ROOFS_URL__: string;

const KIND_NAME: Record<string, string> = {
  teach: '教学科研', dorm: '学生宿舍', home: '家属住宅', hall: '场馆', canteen: '餐厅', tower: '大厦', roof: '构筑物', misc: '建筑',
};

const game = $<HTMLCanvasElement>('game');
const hud = $<HTMLCanvasElement>('hud');
const gctx = game.getContext('2d', { alpha: false })!;
const hctx = hud.getContext('2d')!;
const mini = $<HTMLCanvasElement>('mini');
const mctx = mini.getContext('2d')!;

let world: World;
let view: View;
let coll: Collision;
let ov: HTMLCanvasElement;
let mode: Mode = 'map';
let season: Season;
let profile: Profile;

const dpr = Math.min(window.devicePixelRatio || 1, 3);
const hudDpr = Math.min(dpr, 2);
let cssW = 0, cssH = 0;
// map camera: centre in metres, CSS px per metre
const cam = { x: 0, y: 0, s: 1 };
let mapDirty = true;
// walk camera: device px per texel
let zoom = 3;
let tw = 0, th = 0, camX = 0, camY = 0;
let pinchAcc = 1;

const me: Actor = { id: 0, name: '', look: 0, x: 0, y: 0, dir: 0, moving: false, running: false, animT: 0, chat: null, me: true };
const actors: Actor[] = [];
let target: { label: string; open: () => void } | null = null;
let mapLabels: Array<{ x0: number; y0: number; x1: number; y1: number; open: () => void }> = [];

const net = new Net({
  status: (s, detail) => {
    const dot = $('netBtn').querySelector('.dot')!;
    dot.className = 'dot' + (s === 'online' ? ' on' : s === 'connecting' ? ' wait' : s === 'error' ? ' err' : '');
    updateNetText();
    if (detail && s === 'error') toast(detail);
  },
  chat: (from, text, self) => {
    if (self) me.chat = { text, until: performance.now() + 6000 };
    logChat(self ? me.name : from?.name ?? '路人', text);
  },
  info: () => updateNetText(),
  roster: () => updateNetText(),
});

function updateNetText() {
  const t = $('netText');
  if (!profile.mp) t.textContent = '单人模式';
  else if (net.status === 'online') t.textContent = `${net.online} 人在线 · 第 ${net.room} 组`;
  else if (net.status === 'connecting') t.textContent = '连接中…';
  else t.textContent = '离线';
}

// ---------------------------------------------------------------- profile
function loadProfile(): Profile {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (p && typeof p.name === 'string') return { mp: true, season: 'auto', names: true, ...p };
  } catch { /* first visit */ }
  return { name: `北科人${Math.floor(1000 + Math.random() * 9000)}`, look: randomLook(), mp: true, season: 'auto', names: true };
}

function saveProfile() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...profile, x: +me.x.toFixed(1), y: +me.y.toFixed(1) }));
}

// ---------------------------------------------------------------- layout
function layout() {
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  hud.width = Math.round(cssW * hudDpr);
  hud.height = Math.round(cssH * hudDpr);
  hud.style.width = cssW + 'px';
  hud.style.height = cssH + 'px';
  if (mode === 'map') {
    const d = Math.min(dpr, 2);
    game.width = Math.round(cssW * d);
    game.height = Math.round(cssH * d);
    game.style.width = cssW + 'px';
    game.style.height = cssH + 'px';
    mapDirty = true;
  } else {
    zoom = clamp(zoom, zoomMin(), zoomMax());
    tw = Math.ceil((cssW * dpr) / zoom);
    th = Math.ceil((cssH * dpr) / zoom);
    game.width = tw;
    game.height = th;
    game.style.width = (tw * zoom) / dpr + 'px';
    game.style.height = (th * zoom) / dpr + 'px';
  }
  gctx.imageSmoothingEnabled = false;
}

/** Keep the number of ground chunks on screen bounded on big screens. */
function zoomMin() {
  return Math.max(1, Math.ceil(Math.sqrt((cssW * cssH * dpr * dpr) / (40 * 256 * 256))));
}
function zoomMax() {
  return Math.max(zoomMin() + 1, Math.round(dpr * 4));
}
function defaultZoom() {
  // phones: ~16 m across the short side, like a farming game; larger screens see more of the campus
  const metres = Math.min(cssW, cssH) < 520 ? 16 : 30;
  return clamp(Math.round((Math.min(cssW, cssH) * dpr) / (metres * PPM)), zoomMin(), zoomMax());
}

function mapScaleMin() {
  return Math.min(cssW / world.w, cssH / world.h) * 0.9;
}
function fitMap() {
  cam.x = world.w / 2;
  cam.y = world.h / 2;
  cam.s = Math.max(mapScaleMin(), Math.min(cssW / 700, cssH / 520));
  mapDirty = true;
}
function clampMap() {
  cam.s = clamp(cam.s, mapScaleMin(), 8);
  cam.x = clamp(cam.x, 0, world.w);
  cam.y = clamp(cam.y, 0, world.h);
}

// ---------------------------------------------------------------- modes
function setMode(m: Mode) {
  if (m === mode) return;
  mode = m;
  closeSheet();
  input.resetJoystick();
  for (const id of ['mapbar', 'compass', 'scalebar', 'enter', 'foot']) $(id).hidden = m !== 'map';
  $('walkui').hidden = m !== 'walk';
  $('chatform').hidden = true;
  if (m === 'walk') {
    if (!zoomSet) { zoom = defaultZoom(); zoomSet = true; }
    if (profile.mp && net.status === 'offline') net.connect(profile.name, profile.look);
  } else {
    cam.x = me.x || cam.x;
    cam.y = me.y || cam.y;
    cam.s = Math.max(cam.s, 2.2);
    clampMap();
  }
  layout();
}
let zoomSet = false;

function spawnDefault(): [number, number] {
  const gate = world.gates.find((g) => g.t === '西门') ?? world.gates[0];
  if (gate) return [gate.x + 14, gate.y];
  return [world.w / 2, world.h / 2];
}

function walkTo(x: number, y: number) {
  [me.x, me.y] = coll.free(x, y);
  setMode('walk');
  net.sendState(me.x, me.y, stateByte(), true);
}

// ---------------------------------------------------------------- input
const input = new Input(game, {
  mode: () => mode,
  tap: (x, y) => (mode === 'map' ? mapTap(x, y) : undefined),
  pan: (dx, dy) => {
    cam.x -= dx / cam.s;
    cam.y -= dy / cam.s;
    clampMap();
    mapDirty = true;
  },
  zoom: (f, cx, cy) => {
    if (mode === 'map') {
      const wx = cam.x + (cx - cssW / 2) / cam.s, wy = cam.y + (cy - cssH / 2) / cam.s;
      cam.s *= f;
      clampMap();
      cam.x = wx - (cx - cssW / 2) / cam.s;
      cam.y = wy - (cy - cssH / 2) / cam.s;
      clampMap();
      mapDirty = true;
    } else {
      pinchAcc *= f;
      if (pinchAcc > 1.22 || pinchAcc < 0.82) {
        const z = clamp(zoom + (pinchAcc > 1 ? 1 : -1), zoomMin(), zoomMax());
        pinchAcc = 1;
        if (z !== zoom) { zoom = z; layout(); }
      }
    }
  },
  key: (code) => {
    if (code === 'Escape') {
      if (closeSheet()) return;
      if (!$('chatform').hidden) { $('chatform').hidden = true; return; }
      setMode(mode === 'map' ? 'walk' : 'map');
    } else if (code === 'KeyM') setMode(mode === 'map' ? 'walk' : 'map');
    else if (mode === 'walk' && (code === 'Space' || code === 'KeyE')) target?.open();
    else if (mode === 'walk' && code === 'Enter') openChat();
  },
});

// ---------------------------------------------------------------- map mode
function hitBuilding(x: number, y: number): Building | null {
  // roofs are drawn raised by the wall height, so test the raised footprint first
  let best: Building | null = null;
  for (const b of world.buildings) {
    const lift = b.h * VSCALE * 0.9;
    if (x < b.minx || x > b.maxx || y + lift < b.miny || y > b.maxy) continue;
    if (inPoly(x, y + lift, b.p) || inPoly(x, y, b.p)) {
      if (!best || b.maxy > best.maxy) best = b;
    }
  }
  return best;
}

function mapTap(sx: number, sy: number) {
  for (const l of mapLabels) {
    if (sx >= l.x0 && sx <= l.x1 && sy >= l.y0 && sy <= l.y1) { l.open(); return; }
  }
  const x = cam.x + (sx - cssW / 2) / cam.s, y = cam.y + (sy - cssH / 2) / cam.s;
  const b = hitBuilding(x, y);
  if (b) buildingSheet(b);
}

function buildingSheet(b: Building) {
  const inside = view.pois.filter((p) => p.building === b && p.t !== b.name);
  const go = el('button', { cls: 'pbtn gold', type: 'button', textContent: '走到这里' });
  go.onclick = () => {
    const g = view.buildings.geo[b.id];
    if (g.door) walkTo(g.door.x / PPM, g.door.y / PPM + 1.5);
    else walkTo(b.cx, b.maxy + 1.5);
  };
  const body = el('div', {},
    el('p', { cls: 'kv', innerHTML: `类型 <b>${KIND_NAME[b.kind] ?? '建筑'}</b>　约 <b>${b.floors}</b> 层` }),
    ...(inside.length ? [el('p', { cls: 'kv', innerHTML: `楼内 / 附近：<b>${inside.map((p) => escapeHtml(p.t)).join('、')}</b>` })] : []),
    el('p', { cls: 'kv', textContent: b.campus ? '位于北京科技大学学院路校区内' : '位于校园周边' }),
    el('div', { cls: 'actions' }, go),
  );
  openSheet(b.name || '建筑', body);
}

function poiSheet(p: Poi) {
  const go = el('button', { cls: 'pbtn gold', type: 'button', textContent: '走到这里' });
  go.onclick = () => walkTo(p.x, p.y + 1.5);
  const kind = p.kind === 'gate' ? '校门' : p.kind === 'parking' ? '停车场' : p.building ? `位于${p.building.name || '建筑'}` : '地点';
  openSheet(p.t, el('div', {}, el('p', { cls: 'kv', innerHTML: `<b>${escapeHtml(kind)}</b>` }), el('div', { cls: 'actions' }, go)));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function drawMap() {
  view.drawOverview(gctx, ov, cssW, cssH, game.width / cssW, cam.x, cam.y, cam.s);
  hctx.setTransform(hudDpr, 0, 0, hudDpr, 0, 0);
  hctx.clearRect(0, 0, cssW, cssH);
  const sx = (x: number) => cssW / 2 + (x - cam.x) * cam.s;
  const sy = (y: number) => cssH / 2 + (y - cam.y) * cam.s;
  const placed: Array<[number, number, number, number]> = [];
  mapLabels = [];
  const fits = (x0: number, y0: number, x1: number, y1: number) =>
    x1 > 0 && y1 > 0 && x0 < cssW && y0 < cssH && !placed.some((r) => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]);
  const label = (text: string, x: number, y: number, style: 'b' | 'poi' | 'road' | 'gate', open?: () => void) => {
    const fs = style === 'b' ? 12 : 11;
    hctx.font = `${style === 'road' ? 'italic ' : ''}${style === 'b' ? 600 : 500} ${fs}px system-ui, sans-serif`;
    const w = hctx.measureText(text).width + 8, h = fs + 6;
    const x0 = x - w / 2, y0 = y - h / 2;
    if (!fits(x0 - 2, y0 - 2, x0 + w + 2, y0 + h + 2)) return;
    placed.push([x0 - 2, y0 - 2, x0 + w + 2, y0 + h + 2]);
    if (style === 'road') {
      hctx.fillStyle = 'rgba(0,0,0,0.65)';
      hctx.fillText(text, x0 + 5, y0 + fs + 2);
      hctx.fillStyle = '#f4f1e8';
      hctx.fillText(text, x0 + 4, y0 + fs + 1);
      return;
    }
    hctx.fillStyle = style === 'gate' ? 'rgba(122,30,30,0.9)' : style === 'poi' ? 'rgba(30,58,95,0.88)' : 'rgba(27,27,34,0.86)';
    hctx.fillRect(x0, y0, w, h);
    hctx.strokeStyle = '#0d0d12';
    hctx.lineWidth = 1;
    hctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    hctx.fillStyle = '#f4f1e8';
    hctx.fillText(text, x0 + 4, y0 + fs + 1);
    if (open) mapLabels.push({ x0, y0, x1: x0 + w, y1: y0 + h, open });
  };
  // gates first, then buildings by size, then smaller places and roads
  for (const p of view.pois) if (p.kind === 'gate' && cam.s > 0.9) label(p.t, sx(p.x), sy(p.y), 'gate', () => poiSheet(p));
  const named = world.buildings.filter((b) => b.name && (b.campus || cam.s > 2)).sort((a, b) => (b.maxx - b.minx) * (b.maxy - b.miny) - (a.maxx - a.minx) * (a.maxy - a.miny));
  for (const b of named) {
    const [ax, ay] = View.roofAnchor(b);
    label(b.name, sx(ax), sy(ay), 'b', () => buildingSheet(b));
  }
  if (cam.s > 1.7) {
    for (const p of view.pois) if (p.kind === 'poi' && !p.building) label(p.t, sx(p.x), sy(p.y), 'poi', () => poiSheet(p));
  }
  if (cam.s > 1.1) {
    const seen = new Set<string>();
    for (const r of world.roads) {
      if (seen.has(r.t) && cam.s < 2.5) continue;
      seen.add(r.t);
      label(r.t, sx(r.x), sy(r.y), 'road');
    }
  }
  // players
  for (const r of net.remotes.values()) dot(sx(r.x), sy(r.y), '#f2c94c');
  if (me.x) dot(sx(me.x), sy(me.y), '#ef4444', 5);
  // scale bar
  const metres = [20, 50, 100, 200, 500].find((m) => m * cam.s > 60) ?? 500;
  ($('scalebar').firstElementChild as HTMLElement).style.width = metres * cam.s + 'px';
  $('scalebar').lastElementChild!.textContent = `${metres} 米`;
  mapDirty = false;
}

function dot(x: number, y: number, c: string, r = 4) {
  hctx.fillStyle = '#0d0d12';
  hctx.fillRect(x - r - 1, y - r - 1, r * 2 + 2, r * 2 + 2);
  hctx.fillStyle = c;
  hctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// ---------------------------------------------------------------- walk mode
function stateByte() {
  return (me.dir & 3) | (me.moving ? 4 : 0) | (me.running ? 8 : 0);
}

function updateWalk(dt: number) {
  const a = input.axis();
  const wasMoving = me.moving;
  me.moving = a.x !== 0 || a.y !== 0;
  me.running = a.run;
  if (me.moving) {
    const sp = (a.run ? RUN : WALK) * Math.min(1, Math.hypot(a.x, a.y) * 1.25);
    [me.x, me.y] = coll.move(me.x, me.y, a.x * sp * dt, a.y * sp * dt);
    me.dir = Math.abs(a.x) > Math.abs(a.y) ? (a.x < 0 ? 1 : 2) : a.y < 0 ? 3 : 0;
    me.animT += dt;
  } else me.animT = 0;
  net.sendState(me.x, me.y, stateByte(), wasMoving !== me.moving);
  net.update(dt);
}

function drawWalk() {
  camX = Math.round(me.x * PPM - tw / 2);
  camY = Math.round(me.y * PPM - th / 2 - 12);
  actors.length = 0;
  actors.push(me);
  for (const r of net.remotes.values()) actors.push(r as Remote & Actor);
  view.drawWorld(gctx, tw, th, camX, camY, actors, me);
  drawWalkHud();
}

function drawWalkHud() {
  const k = zoom / dpr; // CSS px per texel
  const X = (tx: number) => (tx - camX) * k, Y = (ty: number) => (ty - camY) * k;
  hctx.setTransform(hudDpr, 0, 0, hudDpr, 0, 0);
  hctx.clearRect(0, 0, cssW, cssH);
  hctx.textAlign = 'center';
  hctx.textBaseline = 'middle';
  // building name boards
  const fs = Math.max(10, Math.min(16, 9 * k));
  hctx.font = `600 ${fs}px system-ui, sans-serif`;
  for (const s of view.hudSigns) {
    hctx.save();
    hctx.beginPath();
    hctx.rect(X(s.x - s.w / 2), Y(s.y) - fs, s.w * k, fs * 2);
    hctx.clip();
    hctx.fillStyle = '#fff';
    hctx.fillText(s.text, X(s.x), Y(s.y) + 0.5);
    hctx.restore();
  }
  // nearby place names over posts
  hctx.font = `500 ${Math.max(11, fs - 1)}px system-ui, sans-serif`;
  for (const p of view.pois) {
    if (p.building) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d > 22) continue;
    const x = X(p.x * PPM), y = Y(p.y * PPM - (p.kind === 'gate' ? 44 : 32));
    pill(p.t, x, y, p.kind === 'gate' ? 'rgba(122,30,30,0.9)' : 'rgba(27,27,34,0.8)');
  }
  // names and chat bubbles
  const now = performance.now();
  hctx.font = `500 ${Math.max(11, Math.min(14, 7 * k))}px system-ui, sans-serif`;
  for (const a of actors) {
    const x = X(a.x * PPM), y = Y(a.y * PPM - CH - 4);
    if (x < -60 || x > cssW + 60 || y < -40 || y > cssH + 40) continue;
    if (profile.names) pill(a.me ? '我' : a.name, x, y, a.me ? 'rgba(0,78,162,0.85)' : 'rgba(27,27,34,0.7)');
    if (a.chat && a.chat.until > now) bubble(a.chat.text, x, y - 18);
  }
}

function pill(text: string, x: number, y: number, bg: string) {
  const w = hctx.measureText(text).width + 8;
  const h = parseInt(hctx.font.split(' ')[1]) + 4;
  hctx.fillStyle = bg;
  hctx.fillRect(x - w / 2, y - h / 2, w, h);
  hctx.fillStyle = '#fff';
  hctx.fillText(text, x, y + 0.5);
}

function bubble(text: string, x: number, y: number) {
  hctx.font = '500 13px system-ui, sans-serif';
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (hctx.measureText(cur + ch).width > 150) { lines.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) lines.push(cur);
  const w = Math.max(...lines.map((l) => hctx.measureText(l).width)) + 14, h = lines.length * 17 + 8;
  const x0 = Math.round(x - w / 2), y0 = Math.round(y - h);
  hctx.fillStyle = '#0d0d12';
  hctx.fillRect(x0 - 2, y0 - 2, w + 4, h + 4);
  hctx.fillStyle = '#fbf8ef';
  hctx.fillRect(x0, y0, w, h);
  hctx.fillRect(x - 3, y0 + h, 6, 4);
  hctx.fillStyle = '#1b1b22';
  lines.forEach((l, i) => hctx.fillText(l, x, y0 + 12 + i * 17));
}

let miniT = 0, placeT = 0, targetT = 0;
function drawMini(now: number) {
  if (now - miniT < 200) return;
  miniT = now;
  const S = 1.6; // metres per minimap px
  const half = 60 * S;
  mctx.imageSmoothingEnabled = false;
  mctx.fillStyle = '#2b2b33';
  mctx.fillRect(0, 0, 120, 120);
  mctx.drawImage(ov, (me.x - half) * OV_PPM, (me.y - half) * OV_PPM, half * 2 * OV_PPM, half * 2 * OV_PPM, 0, 0, 120, 120);
  for (const r of net.remotes.values()) {
    const x = 60 + (r.x - me.x) / S, y = 60 + (r.y - me.y) / S;
    if (x < 0 || y < 0 || x > 120 || y > 120) continue;
    mctx.fillStyle = '#000';
    mctx.fillRect(x - 2, y - 2, 5, 5);
    mctx.fillStyle = '#f2c94c';
    mctx.fillRect(x - 1, y - 1, 3, 3);
  }
  mctx.fillStyle = '#000';
  mctx.fillRect(57, 57, 7, 7);
  mctx.fillStyle = '#ef4444';
  mctx.fillRect(58, 58, 5, 5);
}

function updatePlace(now: number) {
  if (now - placeT < 500) return;
  placeT = now;
  let best: Building | null = null, bd = 30;
  for (const b of world.buildings) {
    if (!b.name) continue;
    const dx = Math.max(b.minx - me.x, 0, me.x - b.maxx), dy = Math.max(b.miny - me.y, 0, me.y - b.maxy);
    const d = Math.hypot(dx, dy);
    if (d < bd) { bd = d; best = b; }
  }
  const inCampus = inPoly(me.x, me.y, world.campus);
  const area = inCampus ? '学院路校区' : '校外';
  $('place').textContent = best ? `${area} · ${best.name}${bd > 2 ? '附近' : ''}` : area;
  const { hour, minute, month } = beijingNow();
  $('clock').textContent = `${SEASON_NAME[season]}  ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (now - lightT > 30000) applyLight(month, hour, minute);
}

let lightT = 0;
function applyLight(month: number, hour: number, minute: number) {
  lightT = performance.now();
  const l = daylight(hour, minute, month);
  view.tint = l.tint;
  view.night = l.night;
  view.buildings.setNight(l.night > 0.55);
}

function updateTarget(now: number) {
  if (now - targetT < 150) return;
  targetT = now;
  let best: { label: string; open: () => void } | null = null, bd = 3.2;
  for (const g of view.buildings.geo) {
    if (!g.door || !g.sign) continue;
    const d = Math.hypot(g.door.x / PPM - me.x, g.door.y / PPM - me.y);
    if (d < bd) { bd = d; const b = g.b; best = { label: `查看 · ${b.name}`, open: () => buildingSheet(b) }; }
  }
  for (const p of view.pois) {
    if (p.building) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < Math.min(bd, p.kind === 'gate' ? 6 : 2.5)) { bd = d; best = { label: `查看 · ${p.t}`, open: () => poiSheet(p) }; }
  }
  if (best?.label !== target?.label) {
    target = best;
    const b = $<HTMLButtonElement>('act');
    b.hidden = !best;
    if (best) b.textContent = best.label;
  }
}

// ---------------------------------------------------------------- chat
function openChat() {
  const f = $('chatform');
  f.hidden = false;
  input.resetJoystick();
  $<HTMLInputElement>('chatInput').focus();
}

function logChat(name: string, text: string, sys = false) {
  const log = $('chatlog');
  const p = el('p', { cls: sys ? 'sys' : '' }, el('b', { textContent: name }), text);
  log.append(p);
  while (log.children.length > 6) log.firstElementChild!.remove();
  window.setTimeout(() => { p.style.opacity = '0'; window.setTimeout(() => p.remove(), 700); }, 14000);
}

// ---------------------------------------------------------------- loop
let last = performance.now();
let mapAnimT = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (mode === 'walk') {
    updateWalk(dt);
    drawWalk();
    drawMini(now);
    updatePlace(now);
    updateTarget(now);
    if (now - saveT > 4000) { saveT = now; saveProfile(); }
  } else {
    net.update(dt);
    if (net.remotes.size && now - mapAnimT > 250) { mapAnimT = now; mapDirty = true; }
    if (mapDirty) drawMap();
  }
  requestAnimationFrame(frame);
}
let saveT = 0;

// ---------------------------------------------------------------- boot
async function boot() {
  profile = loadProfile();
  profile.name = cleanText(profile.name, NAME_MAX) || '北科人';
  me.name = profile.name;
  me.look = profile.look;
  initSheet();
  const bar = $('progBar');
  bar.style.width = '15%';
  world = await loadWorld({ campus: __CAMPUS_URL__, ground: __GROUND_URL__, roofs: __ROOFS_URL__ }, (p) => (bar.style.width = `${Math.round(p * 70)}%`));
  const { month, hour, minute } = beijingNow();
  season = profile.season === 'auto' ? seasonOf(month) : profile.season;
  $('loadText').textContent = '正在绘制像素…';
  await new Promise((r) => setTimeout(r, 0));
  view = new View(world, season);
  world.roofs.close();
  coll = new Collision(world);
  bar.style.width = '85%';
  await new Promise((r) => setTimeout(r, 0));
  ov = buildOverview(world, season, view.buildings);
  applyLight(month, hour, minute);
  // #x,y (metres in the world frame) opens the walk view at that spot
  const link = /^#(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(location.hash);
  if (link) [profile.x, profile.y] = [+link[1], +link[2]];
  [me.x, me.y] = profile.x && profile.y ? coll.free(profile.x, profile.y) : coll.free(...spawnDefault());
  layout();
  fitMap();
  bar.style.width = '100%';
  const coarse = matchMedia('(pointer: coarse)').matches;
  $('hint').textContent = coarse ? '点楼宇或地标查看名称；拖动平移，双指缩放' : '点楼宇或地标查看名称；拖动平移，滚轮缩放，M 或 Esc 进去逛逛';
  const loading = $('loading');
  loading.style.opacity = '0';
  window.setTimeout(() => loading.remove(), 400);
  requestAnimationFrame(frame);

  $('enter').onclick = () => setMode('walk');
  $('zoomIn').onclick = () => { cam.s *= 1.4; clampMap(); mapDirty = true; };
  $('zoomOut').onclick = () => { cam.s /= 1.4; clampMap(); mapDirty = true; };
  $('locate').onclick = locate;
  $('mini').onclick = () => setMode('map');
  $('act').onclick = () => target?.open();
  $('chatBtn').onclick = openChat;
  $('setBtn').onclick = () => settingsSheet(profile, applyProfile);
  $('netBtn').onclick = roomsSheet;
  $('chatform').onsubmit = (e) => {
    e.preventDefault();
    const inp = $<HTMLInputElement>('chatInput');
    const text = cleanText(inp.value, 80);
    inp.value = '';
    $('chatform').hidden = true;
    inp.blur();
    if (!text) return;
    if (profile.mp && net.status === 'online') net.sendChat(text);
    else {
      me.chat = { text, until: performance.now() + 6000 };
      logChat(me.name, text);
    }
  };
  addEventListener('resize', layout);
  addEventListener('orientationchange', () => setTimeout(layout, 200));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveProfile();
    last = performance.now();
  });
  updateNetText();
  if (link) setMode('walk');
}

function applyProfile(p: Profile) {
  const seasonChanged = p.season !== profile.season;
  profile = { ...p, name: cleanText(p.name, NAME_MAX) || profile.name };
  me.name = profile.name;
  me.look = profile.look;
  if (seasonChanged) {
    season = profile.season === 'auto' ? seasonOf(beijingNow().month) : profile.season;
    view.setSeason(season);
    ov = buildOverview(world, season, view.buildings);
    mapDirty = true;
  }
  if (profile.mp && mode === 'walk') {
    if (net.status === 'offline') net.connect(profile.name, profile.look);
    else net.updateProfile(profile.name, profile.look);
  } else if (!profile.mp && net.status !== 'offline') net.disconnect();
  updateNetText();
  saveProfile();
}

function roomsSheet() {
  const body = el('div', {});
  if (!profile.mp) {
    body.append(el('p', { cls: 'kv', textContent: '单人模式：别人看不到你，你也看不到别人。' }));
    const on = el('button', { cls: 'pbtn gold', type: 'button', textContent: '切换到多人模式' });
    on.onclick = () => { applyProfile({ ...profile, mp: true }); closeSheet(); };
    body.append(el('div', { cls: 'actions' }, on));
  } else {
    body.append(el('p', { cls: 'kv', innerHTML: `全站 <b>${net.online}</b> 人在线；每组最多 50 人，只能看到同组的人。` }));
    const grid = el('div', { cls: 'rooms' });
    net.rooms.forEach((n, i) => {
      const b = el('button', { cls: 'pbtn' + (i + 1 === net.room ? ' gold' : ''), type: 'button', textContent: `第 ${i + 1} 组 · ${n} 人` });
      b.onclick = () => { net.switchRoom(i + 1); closeSheet(); };
      grid.append(b);
    });
    body.append(grid);
    const next = el('button', { cls: 'pbtn', type: 'button', textContent: '换一组' });
    next.onclick = () => { net.switchRoom(0); closeSheet(); };
    const off = el('button', { cls: 'pbtn', type: 'button', textContent: '改为单人' });
    off.onclick = () => { applyProfile({ ...profile, mp: false }); closeSheet(); };
    body.append(el('div', { cls: 'actions' }, off, next));
  }
  openSheet('在线', body);
}

function locate() {
  if (!navigator.geolocation) { toast('浏览器不支持定位'); return; }
  toast('定位中…');
  navigator.geolocation.getCurrentPosition((pos) => {
    const [x, y] = lonLatToWorld(world, pos.coords.longitude, pos.coords.latitude);
    if (x < 0 || y < 0 || x > world.w || y > world.h) { toast('你现在不在北科附近'); return; }
    cam.x = x; cam.y = y; cam.s = Math.max(cam.s, 3);
    clampMap();
    me.x = x; me.y = y;
    [me.x, me.y] = coll.free(x, y);
    mapDirty = true;
    toast('已定位，点“进去逛逛”从这里出发');
  }, () => toast('无法获取位置'), { enableHighAccuracy: true, timeout: 8000 });
}

boot().catch((e) => {
  $('loadText').textContent = '加载失败，请刷新重试';
  console.error(e);
});
