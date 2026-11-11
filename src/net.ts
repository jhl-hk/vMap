import {
  decodeServer, encodeChat, encodeHello, encodeRoom, encodeState, S_ADD, S_CHAT, S_DEL, S_ERROR, S_INFO, S_SNAP,
  S_WELCOME, WS_PATH,
} from '../shared/protocol.js';
import { INTERP_MS } from './config';

export interface Remote {
  id: number;
  name: string;
  look: number;
  /** Snapshot history: time, x, y (metres), state. */
  hist: Array<[number, number, number, number]>;
  x: number;
  y: number;
  st: number;
  moving: boolean;
  running: boolean;
  dir: number;
  animT: number;
  chat: { text: string; until: number } | null;
}

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

export interface NetEvents {
  status(s: NetStatus, detail?: string): void;
  chat(from: Remote | null, text: string, self: boolean): void;
  info(online: number, room: number, rooms: number[]): void;
  roster(): void;
}

export class Net {
  ws: WebSocket | null = null;
  status: NetStatus = 'offline';
  myId = 0;
  room = 0;
  online = 0;
  rooms: number[] = [];
  remotes = new Map<number, Remote>();
  private lastSent = { x: -1, y: -1, st: -1, t: 0 };
  private retry = 0;
  private retryTimer = 0;
  private wanted = false;
  private profile = { name: '', look: 0 };

  constructor(private ev: NetEvents) {}

  connect(name: string, look: number) {
    this.profile = { name, look };
    this.wanted = true;
    this.open();
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.remotes.clear();
    this.setStatus('offline');
    this.ev.roster();
  }

  /** Update name/look: the server learns them on (re)join. */
  updateProfile(name: string, look: number) {
    const changed = name !== this.profile.name || look !== this.profile.look;
    this.profile = { name, look };
    if (changed && this.wanted) {
      this.ws?.close();
    }
  }

  private open() {
    clearTimeout(this.retryTimer);
    this.setStatus('connecting');
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + WS_PATH;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(encodeHello(this.profile.look, this.room, this.profile.name));
      this.lastSent.t = 0;
    };
    ws.onmessage = (e) => this.onMessage(e.data as ArrayBuffer);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.remotes.clear();
      this.ev.roster();
      if (this.wanted) this.scheduleRetry();
      else this.setStatus('offline');
    };
  }

  private scheduleRetry() {
    this.setStatus('error', '连接断开，正在重连…');
    const delay = Math.min(15000, 800 * 2 ** this.retry++);
    this.retryTimer = window.setTimeout(() => this.wanted && this.open(), delay);
  }

  private setStatus(s: NetStatus, detail?: string) {
    this.status = s;
    this.ev.status(s, detail);
  }

  private onMessage(buf: ArrayBuffer) {
    const m = decodeServer(buf);
    if (!m) return;
    const now = performance.now();
    switch (m.type) {
      case S_WELCOME:
        this.myId = m.id;
        this.room = m.room;
        this.online = m.online;
        this.remotes.clear();
        this.setStatus('online');
        break;
      case S_ADD:
        for (const p of m.players) {
          const x = p.x / 10, y = p.y / 10;
          this.remotes.set(p.id, {
            id: p.id, name: p.name, look: p.look, hist: [[now, x, y, p.st]], x, y, st: p.st,
            moving: false, running: false, dir: p.st & 3, animT: 0, chat: null,
          });
        }
        this.ev.roster();
        break;
      case S_DEL:
        for (const id of m.ids) this.remotes.delete(id);
        this.ev.roster();
        break;
      case S_SNAP:
        for (let i = 0; i < m.ids.length; i++) {
          const r = this.remotes.get(m.ids[i]);
          if (!r) continue;
          r.hist.push([now, m.xs[i] / 10, m.ys[i] / 10, m.sts[i]]);
          if (r.hist.length > 12) r.hist.shift();
        }
        break;
      case S_CHAT: {
        const self = m.id === this.myId;
        const r = this.remotes.get(m.id) ?? null;
        if (r) r.chat = { text: m.text, until: now + 6000 };
        this.ev.chat(r, m.text, self);
        break;
      }
      case S_INFO:
        this.online = m.online;
        this.room = m.room;
        this.rooms = m.rooms;
        this.ev.info(m.online, m.room, m.rooms);
        break;
      case S_ERROR:
        this.setStatus('error', m.text);
        this.wanted = false;
        break;
    }
  }

  /** Send our state at most every 100 ms while it changes, plus a heartbeat every 5 s. */
  sendState(x: number, y: number, st: number, force = false) {
    if (!this.ws || this.status !== 'online') return;
    const now = performance.now();
    const xi = Math.max(0, Math.round(x * 10)), yi = Math.max(0, Math.round(y * 10));
    const changed = xi !== this.lastSent.x || yi !== this.lastSent.y || st !== this.lastSent.st;
    const stChanged = st !== this.lastSent.st;
    if (!force && !(changed && (now - this.lastSent.t >= 100 || stChanged)) && now - this.lastSent.t < 5000) return;
    this.ws.send(encodeState(xi, yi, st));
    this.lastSent = { x: xi, y: yi, st, t: now };
  }

  sendChat(text: string) {
    if (this.ws && this.status === 'online') this.ws.send(encodeChat(text));
  }

  switchRoom(room = 0) {
    if (this.ws && this.status === 'online') this.ws.send(encodeRoom(room));
  }

  /** Interpolate remote players for rendering. */
  update(dt: number) {
    const t = performance.now() - INTERP_MS;
    for (const r of this.remotes.values()) {
      const h = r.hist;
      let i = h.length - 1;
      while (i > 0 && h[i - 1][0] > t) i--;
      if (i === 0 || h[i][0] <= t) {
        const last = h[h.length - 1];
        r.x = last[1]; r.y = last[2]; r.st = last[3];
      } else {
        const a = h[i - 1], b = h[i];
        const k = (t - a[0]) / Math.max(1, b[0] - a[0]);
        r.x = a[1] + (b[1] - a[1]) * k;
        r.y = a[2] + (b[2] - a[2]) * k;
        r.st = b[3];
      }
      r.moving = (r.st & 4) !== 0;
      r.running = (r.st & 8) !== 0;
      r.dir = r.st & 3;
      if (r.moving) r.animT += dt;
      if (r.chat && r.chat.until < performance.now()) r.chat = null;
    }
  }
}
