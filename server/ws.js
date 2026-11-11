// Minimal RFC 6455 server side: binary/text frames, ping/pong, close.
// No extensions, no fragmentation (clients here only send small single-frame messages).
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Complete the HTTP upgrade. Returns a WsConn or null when the request is not a valid handshake. */
export function acceptUpgrade(req, socket, { maxPayload = 1024 } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (req.method !== 'GET' || !key || req.headers['sec-websocket-version'] !== '13' ||
      String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  return new WsConn(socket, maxPayload);
}

/** Build one frame that can be written to many sockets. */
export function frame(payload, opcode = 0x2) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export class WsConn {
  constructor(socket, maxPayload) {
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.lastSeen = Date.now();
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => socket.destroy());
  }

  /** Write a pre-built frame; drops it when the peer is not keeping up. */
  sendFrame(f) {
    if (!this.open) return;
    if (this.socket.writableLength > 256 * 1024) return;
    this.socket.write(f);
  }

  send(payload) {
    this.sendFrame(frame(Buffer.isBuffer(payload) ? payload : Buffer.from(payload)));
  }

  ping() {
    this.sendFrame(frame(Buffer.alloc(0), 0x9));
  }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this.socket.write(frame(p, 0x8));
    this.socket.end();
    this.open = false;
  }

  _closed() {
    this.open = false;
    if (this._done) return;
    this._done = true;
    if (this.onclose) this.onclose();
  }

  _data(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (!masked || !fin || (b0 & 0x70)) return this._fail(1002);
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        return this._fail(1009);
      }
      if (len > this.maxPayload) return this._fail(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) { this.sendFrame(frame(data, 0xa)); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2) {
        if (this.onmessage) this.onmessage(data);
        continue;
      }
      return this._fail(1002);
    }
  }

  _fail(code) {
    this.close(code);
    this.socket.destroy();
  }
}
