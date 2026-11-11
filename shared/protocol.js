// Binary protocol shared by the browser client and the realtime server.
// Positions are unsigned 16-bit decimetres in the world frame (x east, y south).
// State byte: bits 0-1 facing (0 down, 1 left, 2 right, 3 up), bit 2 moving,
// bit 3 running, bit 4 riding a bike, bits 5-7 emote id (0 none).

export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';

export const C_HELLO = 1;
export const C_STATE = 2;
export const C_CHAT = 3;
export const C_ROOM = 4;

export const S_WELCOME = 0x81;
export const S_ADD = 0x82;
export const S_DEL = 0x83;
export const S_SNAP = 0x84;
export const S_CHAT = 0x85;
export const S_INFO = 0x86;
export const S_ERROR = 0x87;

export const NAME_MAX = 12;
export const CHAT_MAX = 80;
export const TICK_MS = 100;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Keep printable characters only and cap the length in code points. */
export function cleanText(s, max) {
  const chars = Array.from(String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim());
  return chars.slice(0, max).join('');
}

export function encodeHello(look, room, name) {
  const nb = enc.encode(cleanText(name, NAME_MAX));
  const b = new Uint8Array(7 + nb.length);
  const v = new DataView(b.buffer);
  v.setUint8(0, C_HELLO);
  v.setUint8(1, PROTOCOL_VERSION);
  v.setUint32(2, look >>> 0, true);
  v.setUint8(6, room);
  b.set(nb, 7);
  return b;
}

export function encodeState(x, y, st) {
  const b = new Uint8Array(6);
  const v = new DataView(b.buffer);
  v.setUint8(0, C_STATE);
  v.setUint16(1, x, true);
  v.setUint16(3, y, true);
  v.setUint8(5, st);
  return b;
}

export function encodeChat(text) {
  const tb = enc.encode(cleanText(text, CHAT_MAX));
  const b = new Uint8Array(1 + tb.length);
  b[0] = C_CHAT;
  b.set(tb, 1);
  return b;
}

export function encodeRoom(room) {
  return new Uint8Array([C_ROOM, room]);
}

/** Decode a server message into a plain object. */
export function decodeServer(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = b[0];
  switch (type) {
    case S_WELCOME:
      return { type, id: v.getUint16(1, true), room: b[3], online: v.getUint16(4, true) };
    case S_ADD: {
      const players = [];
      let o = 1;
      while (o + 12 <= b.length) {
        const id = v.getUint16(o, true);
        const look = v.getUint32(o + 2, true);
        const x = v.getUint16(o + 6, true);
        const y = v.getUint16(o + 8, true);
        const st = b[o + 10];
        const n = b[o + 11];
        const name = dec.decode(b.subarray(o + 12, o + 12 + n));
        players.push({ id, look, x, y, st, name });
        o += 12 + n;
      }
      return { type, players };
    }
    case S_DEL: {
      const ids = [];
      for (let o = 1; o + 2 <= b.length; o += 2) ids.push(v.getUint16(o, true));
      return { type, ids };
    }
    case S_SNAP: {
      const n = (b.length - 1) / 7;
      const ids = new Uint16Array(n), xs = new Uint16Array(n), ys = new Uint16Array(n), sts = new Uint8Array(n);
      for (let i = 0, o = 1; i < n; i++, o += 7) {
        ids[i] = v.getUint16(o, true);
        xs[i] = v.getUint16(o + 2, true);
        ys[i] = v.getUint16(o + 4, true);
        sts[i] = b[o + 6];
      }
      return { type, ids, xs, ys, sts };
    }
    case S_CHAT:
      return { type, id: v.getUint16(1, true), text: dec.decode(b.subarray(3)) };
    case S_INFO: {
      const rooms = [];
      for (let o = 4; o < b.length; o++) rooms.push(b[o]);
      return { type, online: v.getUint16(1, true), room: b[3], rooms };
    }
    case S_ERROR:
      return { type, text: dec.decode(b.subarray(1)) };
    default:
      return null;
  }
}
