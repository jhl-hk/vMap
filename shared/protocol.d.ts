export declare const PROTOCOL_VERSION: number;
export declare const WS_PATH: string;
export declare const C_HELLO: 1;
export declare const C_STATE: 2;
export declare const C_CHAT: 3;
export declare const C_ROOM: 4;
export declare const S_WELCOME: 0x81;
export declare const S_ADD: 0x82;
export declare const S_DEL: 0x83;
export declare const S_SNAP: 0x84;
export declare const S_CHAT: 0x85;
export declare const S_INFO: 0x86;
export declare const S_ERROR: 0x87;
export declare const NAME_MAX: number;
export declare const CHAT_MAX: number;
export declare const TICK_MS: number;

export declare function cleanText(s: string, max: number): string;
export declare function encodeHello(look: number, room: number, name: string): Uint8Array;
export declare function encodeState(x: number, y: number, st: number): Uint8Array;
export declare function encodeChat(text: string): Uint8Array;
export declare function encodeRoom(room: number): Uint8Array;

export type ServerMessage =
  | { type: 0x81; id: number; room: number; online: number }
  | { type: 0x82; players: Array<{ id: number; look: number; x: number; y: number; st: number; name: string }> }
  | { type: 0x83; ids: number[] }
  | { type: 0x84; ids: Uint16Array; xs: Uint16Array; ys: Uint16Array; sts: Uint8Array }
  | { type: 0x85; id: number; text: string }
  | { type: 0x86; online: number; room: number; rooms: number[] }
  | { type: 0x87; text: string };

export declare function decodeServer(buf: ArrayBuffer | Uint8Array): ServerMessage | null;
