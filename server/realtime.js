// Realtime presence for 像素北科: rooms ("组") of up to ROOM_CAP players, 10 Hz delta snapshots.
// Mount into any Node/Bun http server with attachRealtime(server).
import { acceptUpgrade, frame } from './ws.js';
import {
  C_CHAT, C_HELLO, C_ROOM, C_STATE, CHAT_MAX, NAME_MAX, PROTOCOL_VERSION, S_ADD, S_CHAT, S_DEL, S_ERROR,
  S_INFO, S_SNAP, S_WELCOME, TICK_MS, WS_PATH, cleanText,
} from '../shared/protocol.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function createRealtime({
  roomCap = 50, maxClients = 2000, maxPerIp = 6, worldDm = [11370, 8270], idleMs = 70_000, trustProxy = false,
} = {}) {
  /** @type {Map<number, any>} */
  const clients = new Map();
  /** @type {Array<Set<any>>} rooms[0] is "第 1 组" */
  const rooms = [];
  const perIp = new Map();
  let nextId = 1;

  function allocId() {
    for (let i = 0; i < 65535; i++) {
      const id = nextId;
      nextId = nextId >= 65535 ? 1 : nextId + 1;
      if (!clients.has(id)) return id;
    }
    return 0;
  }

  function pickRoom(wanted) {
    if (wanted > 0 && wanted <= rooms.length && rooms[wanted - 1].size < roomCap) return wanted - 1;
    if (wanted === rooms.length + 1) {
      rooms.push(new Set());
      return rooms.length - 1;
    }
    // the fullest room that still has space keeps people together
    let best = -1;
    for (let i = 0; i < rooms.length; i++) {
      if (rooms[i].size < roomCap && (best < 0 || rooms[i].size > rooms[best].size)) best = i;
    }
    if (best >= 0) return best;
    rooms.push(new Set());
    return rooms.length - 1;
  }

  function addRecord(c) {
    const nb = enc.encode(c.name);
    const b = Buffer.alloc(12 + nb.length);
    b.writeUInt16LE(c.id, 0);
    b.writeUInt32LE(c.look >>> 0, 2);
    b.writeUInt16LE(c.x, 6);
    b.writeUInt16LE(c.y, 8);
    b[10] = c.st;
    b[11] = nb.length;
    b.set(nb, 12);
    return b;
  }

  function broadcast(room, payload, except) {
    const f = frame(payload);
    for (const c of rooms[room]) if (c !== except) c.ws.sendFrame(f);
  }

  function joinRoom(c, wanted) {
    const r = pickRoom(wanted);
    c.room = r;
    rooms[r].add(c);
    const w = Buffer.alloc(6);
    w[0] = S_WELCOME;
    w.writeUInt16LE(c.id, 1);
    w[3] = r + 1;
    w.writeUInt16LE(clients.size, 4);
    c.ws.send(w);
    // roster for the newcomer, newcomer for everybody else
    const recs = [];
    for (const o of rooms[r]) if (o !== c) recs.push(addRecord(o));
    for (let i = 0; i < recs.length; i += 40) c.ws.send(Buffer.concat([Buffer.from([S_ADD]), ...recs.slice(i, i + 40)]));
    broadcast(r, Buffer.concat([Buffer.from([S_ADD]), addRecord(c)]), c);
    sendInfo(c);
  }

  function leaveRoom(c) {
    if (c.room < 0) return;
    const r = c.room;
    rooms[r].delete(c);
    c.room = -1;
    const b = Buffer.alloc(3);
    b[0] = S_DEL;
    b.writeUInt16LE(c.id, 1);
    broadcast(r, b);
  }

  function trimRooms() {
    while (rooms.length && rooms[rooms.length - 1].size === 0) rooms.pop();
  }

  function infoPayload(c) {
    const b = Buffer.alloc(4 + rooms.length);
    b[0] = S_INFO;
    b.writeUInt16LE(clients.size, 1);
    b[3] = c.room + 1;
    for (let i = 0; i < rooms.length; i++) b[4 + i] = Math.min(255, rooms[i].size);
    return b;
  }

  function sendInfo(c) {
    c.ws.send(infoPayload(c));
  }

  function onMessage(c, d) {
    const type = d[0];
    if (type === C_HELLO) {
      if (c.room >= 0 || d.length < 7 || d[1] !== PROTOCOL_VERSION) {
        if (d[1] !== PROTOCOL_VERSION) c.ws.send(Buffer.concat([Buffer.from([S_ERROR]), Buffer.from('版本过旧，请刷新页面')]));
        return;
      }
      c.look = d.readUInt32LE(2);
      c.name = cleanText(dec.decode(d.subarray(7)), NAME_MAX) || `北科人${c.id}`;
      joinRoom(c, d[6]);
      return;
    }
    if (c.room < 0) return;
    if (type === C_STATE && d.length === 6) {
      const now = Date.now();
      if (now - c.lastState < 40) return;   // 25 Hz ceiling
      c.lastState = now;
      c.x = Math.min(d.readUInt16LE(1), worldDm[0]);
      c.y = Math.min(d.readUInt16LE(3), worldDm[1]);
      c.st = d[5];
      c.dirty = true;
      return;
    }
    if (type === C_CHAT) {
      const now = Date.now();
      // token bucket: 3 messages burst, one more every 1.5 s
      c.chatTokens = Math.min(3, c.chatTokens + (now - c.chatAt) / 1500);
      c.chatAt = now;
      if (c.chatTokens < 1) return;
      c.chatTokens -= 1;
      const text = cleanText(dec.decode(d.subarray(1)), CHAT_MAX);
      if (!text) return;
      const tb = Buffer.from(enc.encode(text));
      const b = Buffer.alloc(3 + tb.length);
      b[0] = S_CHAT;
      b.writeUInt16LE(c.id, 1);
      b.set(tb, 3);
      broadcast(c.room, b);
      return;
    }
    if (type === C_ROOM && d.length === 2) {
      const now = Date.now();
      if (now - c.roomAt < 2000) return;
      c.roomAt = now;
      let want = d[1];
      if (want === 0) {
        // next room with space; open a new one only when leaving a shared room
        want = -1;
        for (let k = 1; k < rooms.length; k++) {
          const i = (c.room + k) % rooms.length;
          if (rooms[i].size < roomCap) { want = i + 1; break; }
        }
        if (want < 0) {
          if (rooms[c.room].size <= 1) return;
          want = rooms.length + 1;
        }
      }
      if (want - 1 === c.room) return;
      leaveRoom(c);
      joinRoom(c, want);
      trimRooms();
    }
  }

  function handleUpgrade(req, socket) {
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || socket.remoteAddress || '?';
    if (clients.size >= maxClients || (perIp.get(ip) || 0) >= maxPerIp) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = acceptUpgrade(req, socket, { maxPayload: 512 });
    if (!ws) return;
    const id = allocId();
    if (!id) return ws.close(1013);
    const c = {
      id, ws, ip, name: '', look: 0, x: 0, y: 0, st: 0, room: -1, dirty: false,
      lastState: 0, chatTokens: 3, chatAt: Date.now(), roomAt: 0,
    };
    clients.set(id, c);
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    ws.onmessage = (d) => onMessage(c, d);
    ws.onclose = () => {
      leaveRoom(c);
      trimRooms();
      clients.delete(id);
      const n = (perIp.get(ip) || 1) - 1;
      if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
    };
  }

  // one shared snapshot buffer per room per tick
  const tick = setInterval(() => {
    for (let r = 0; r < rooms.length; r++) {
      let n = 0;
      for (const c of rooms[r]) if (c.dirty) n++;
      if (!n) continue;
      const b = Buffer.alloc(1 + n * 7);
      b[0] = S_SNAP;
      let o = 1;
      for (const c of rooms[r]) {
        if (!c.dirty) continue;
        c.dirty = false;
        b.writeUInt16LE(c.id, o);
        b.writeUInt16LE(c.x, o + 2);
        b.writeUInt16LE(c.y, o + 4);
        b[o + 6] = c.st;
        o += 7;
      }
      broadcast(r, b);
    }
  }, TICK_MS);

  const slow = setInterval(() => {
    const now = Date.now();
    for (const c of clients.values()) {
      if (now - c.ws.lastSeen > idleMs) { c.ws.close(1001); c.ws.socket.destroy(); continue; }
      c.ws.ping();
      if (c.room >= 0) sendInfo(c);
    }
  }, 10_000);

  return {
    handleUpgrade,
    stats: () => ({ clients: clients.size, rooms: rooms.map((r) => r.size) }),
    close() {
      clearInterval(tick);
      clearInterval(slow);
      for (const c of clients.values()) c.ws.close(1001);
    },
  };
}

/** Route upgrade requests on `path` to the realtime service. */
export function attachRealtime(server, options = {}) {
  const path = options.path || WS_PATH;
  const rt = createRealtime(options);
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (url === path || url.startsWith(path + '?')) rt.handleUpgrade(req, socket, head);
    else if (!options.passThrough) socket.destroy();
  });
  return rt;
}
