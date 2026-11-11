import { NAME_MAX } from '../shared/protocol.js';
import { BAGS, BOTTOMS, CH, CW, charSheet, decodeLook, encodeLook, HAIR, HAIR_STYLES, SHOES, SKIN, TOPS, type Look } from './render/chars';
import { SEASON_NAME, type Season } from './season';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface Profile {
  name: string;
  look: number;
  mp: boolean;
  season: 'auto' | Season;
  names: boolean;
  x?: number;
  y?: number;
}

let toastTimer = 0;
export function toast(text: string, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

let onSheetClose: (() => void) | null = null;
export function openSheet(title: string, body: HTMLElement | string, onClose?: () => void) {
  $('sheetTitle').textContent = title;
  const b = $('sheetBody');
  b.replaceChildren();
  if (typeof body === 'string') b.innerHTML = body;
  else b.append(body);
  $('sheet').hidden = false;
  onSheetClose = onClose ?? null;
}

export function closeSheet() {
  if ($('sheet').hidden) return false;
  $('sheet').hidden = true;
  const f = onSheetClose;
  onSheetClose = null;
  f?.();
  return true;
}

export function initSheet() {
  $('sheetClose').onclick = () => closeSheet();
  $('sheet').addEventListener('pointerdown', (e) => {
    if (e.target === $('sheet')) closeSheet();
  });
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

function seg<T extends string | number>(options: Array<[T, string]>, value: T, onPick: (v: T) => void): HTMLElement {
  const box = el('div', { cls: 'seg' });
  for (const [v, label] of options) {
    const b = el('button', { cls: 'pbtn', type: 'button', textContent: label });
    b.setAttribute('aria-pressed', String(v === value));
    b.onclick = () => {
      for (const o of box.children) o.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-pressed', 'true');
      onPick(v);
    };
    box.append(b);
  }
  return box;
}

function swatches(colors: string[], value: number, onPick: (i: number) => void): HTMLElement {
  const box = el('div', { cls: 'swatches' });
  colors.forEach((c, i) => {
    const b = el('button', { type: 'button', title: c || '无' });
    b.style.background = c || 'repeating-linear-gradient(45deg,#555 0 4px,#333 4px 8px)';
    b.setAttribute('aria-pressed', String(i === value));
    b.onclick = () => {
      for (const o of box.children) o.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-pressed', 'true');
      onPick(i);
    };
    box.append(b);
  });
  return box;
}

/** Settings: name, avatar, multiplayer, season, labels. */
export function settingsSheet(p: Profile, onSave: (p: Profile) => void) {
  const draft: Profile = { ...p };
  const look: Look = decodeLook(p.look);
  const preview = el('canvas', { width: CW + 2, height: CH + 2 });
  let dir = 0;
  const paint = () => {
    const ctx = preview.getContext('2d')!;
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(charSheet(encodeLook(look)), 0, dir * (CH + 2), CW + 2, CH + 2, 0, 0, CW + 2, CH + 2);
  };
  paint();
  const spin = window.setInterval(() => { dir = (dir + 1) % 4; paint(); }, 900);
  const name = el('input', { type: 'text', value: p.name, maxLength: NAME_MAX * 2, placeholder: '昵称' });
  const pick = <K extends keyof Look>(k: K) => (v: number) => { look[k] = v as Look[K]; paint(); };
  const body = el('div', {},
    el('div', { cls: 'avatar' }, preview, el('div', {},
      el('label', { textContent: `昵称（${NAME_MAX} 字以内）` }), name,
      el('label', { textContent: '肤色' }), swatches(SKIN, look.skin, pick('skin')))),
    el('label', { textContent: '发型' }), seg(HAIR_STYLES.map((s, i) => [i, s] as [number, string]), look.style, pick('style')),
    el('label', { textContent: '发色' }), swatches(HAIR, look.hair, pick('hair')),
    el('label', { textContent: '上衣' }), swatches(TOPS, look.top, pick('top')),
    el('label', { textContent: '裤子' }), swatches(BOTTOMS, look.bottom, pick('bottom')),
    el('label', { textContent: '鞋子' }), swatches(SHOES, look.shoes, pick('shoes')),
    el('label', { textContent: '书包' }), swatches(BAGS, look.bag, pick('bag')),
    el('label', { textContent: '游览模式' }),
    seg<'mp' | 'solo'>([['mp', '多人（同组可见）'], ['solo', '单人（离线）']], p.mp ? 'mp' : 'solo', (v) => (draft.mp = v === 'mp')),
    el('label', { textContent: '季节' }),
    seg<'auto' | Season>([['auto', '跟随日期'], ...(['spring', 'summer', 'autumn', 'winter'] as Season[]).map((s) => [s, SEASON_NAME[s]] as [Season, string])], p.season, (v) => (draft.season = v)),
    el('label', { textContent: '头顶名字' }),
    seg<'on' | 'off'>([['on', '显示'], ['off', '隐藏']], p.names ? 'on' : 'off', (v) => (draft.names = v === 'on')),
  );
  const save = el('button', { cls: 'pbtn gold', type: 'button', textContent: '保存' });
  save.onclick = () => {
    draft.name = name.value.trim() || p.name;
    draft.look = encodeLook(look);
    onSave(draft);
    closeSheet();
  };
  body.append(el('div', { cls: 'actions' }, save));
  openSheet('设置', body, () => clearInterval(spin));
}
