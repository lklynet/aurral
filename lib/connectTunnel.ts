import { isRecord } from "./isRecord.ts";

export const FRAME_REQ_HEAD = 0x01;
export const FRAME_REQ_DATA = 0x02;
export const FRAME_REQ_END = 0x03;
export const FRAME_RES_HEAD = 0x04;
export const FRAME_RES_DATA = 0x05;
export const FRAME_RES_END = 0x06;
export const FRAME_STREAM_RST = 0x07;
export const FRAME_WS_OPEN = 0x08;
export const FRAME_WS_ACCEPTED = 0x09;
export const FRAME_WS_DATA_TEXT = 0x0a;
export const FRAME_WS_DATA_BIN = 0x0b;
export const FRAME_WS_CLOSE = 0x0c;
export const FRAME_PING = 0x0d;
export const FRAME_PONG = 0x0e;
export const FRAME_TICKET_REFRESH = 0x0f;
export const FRAME_STREAM_PAUSE = 0x10;
export const FRAME_STREAM_RESUME = 0x11;

export const TUNNEL_CLOSE_REPLACED = 4009;
export const TUNNEL_CLOSE_EXPIRED = 4008;
export const TUNNEL_CLOSE_UNAUTHORIZED = 4401;

export type FrameType =
  | typeof FRAME_REQ_HEAD
  | typeof FRAME_REQ_DATA
  | typeof FRAME_REQ_END
  | typeof FRAME_RES_HEAD
  | typeof FRAME_RES_DATA
  | typeof FRAME_RES_END
  | typeof FRAME_STREAM_RST
  | typeof FRAME_WS_OPEN
  | typeof FRAME_WS_ACCEPTED
  | typeof FRAME_WS_DATA_TEXT
  | typeof FRAME_WS_DATA_BIN
  | typeof FRAME_WS_CLOSE
  | typeof FRAME_PING
  | typeof FRAME_PONG
  | typeof FRAME_TICKET_REFRESH
  | typeof FRAME_STREAM_PAUSE
  | typeof FRAME_STREAM_RESUME;

export interface ReqHeadPayload {
  method: string;
  path: string;
  headers: [string, string][];
  remoteIp?: string;
}

export interface ResHeadPayload {
  status: number;
  headers: [string, string][];
}

export interface WsOpenPayload {
  path: string;
  headers: [string, string][];
  remoteIp?: string;
}

export interface WsAcceptedPayload {
  protocol?: string;
}

export interface WsClosePayload {
  code: number;
  reason?: string;
}

function parseHeaderEntries(value: unknown): [string, string][] | null {
  if (!Array.isArray(value)) return null;
  const entries: [string, string][] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    if (typeof item[0] !== "string" || typeof item[1] !== "string") return null;
    entries.push([item[0], item[1]]);
  }
  return entries;
}

export function parseReqHead(value: unknown): ReqHeadPayload | null {
  if (!isRecord(value) || typeof value.method !== "string" || typeof value.path !== "string") {
    return null;
  }
  if (value.remoteIp !== undefined && typeof value.remoteIp !== "string") return null;
  const headers = parseHeaderEntries(value.headers);
  if (!headers) return null;
  return {
    method: value.method,
    path: value.path,
    headers,
    ...(value.remoteIp !== undefined && { remoteIp: value.remoteIp }),
  };
}

export function parseResHead(value: unknown): ResHeadPayload | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.status !== "number" ||
    !Number.isInteger(value.status) ||
    value.status < 100 ||
    value.status > 599
  ) {
    return null;
  }
  const headers = parseHeaderEntries(value.headers);
  if (!headers) return null;
  return { status: value.status, headers };
}

export function parseWsOpen(value: unknown): WsOpenPayload | null {
  if (!isRecord(value) || typeof value.path !== "string") return null;
  if (value.remoteIp !== undefined && typeof value.remoteIp !== "string") return null;
  const headers = parseHeaderEntries(value.headers);
  if (!headers) return null;
  return {
    path: value.path,
    headers,
    ...(value.remoteIp !== undefined && { remoteIp: value.remoteIp }),
  };
}

export function parseWsAccepted(value: unknown): WsAcceptedPayload | null {
  if (!isRecord(value)) return null;
  if (value.protocol !== undefined && typeof value.protocol !== "string") return null;
  return value.protocol !== undefined ? { protocol: value.protocol } : {};
}

export function parseWsClose(value: unknown): WsClosePayload | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.code !== "number" ||
    !Number.isInteger(value.code) ||
    value.code < 1000 ||
    value.code > 4999
  ) {
    return null;
  }
  if (value.reason !== undefined && typeof value.reason !== "string") return null;
  return {
    code: value.code,
    ...(value.reason !== undefined && { reason: value.reason }),
  };
}

const HEADER_BYTES = 5;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(type: FrameType, streamId: number, payload?: Uint8Array): Uint8Array {
  const size = payload ? payload.byteLength : 0;
  const frame = new Uint8Array(HEADER_BYTES + size);
  frame[0] = type;
  const view = new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES);
  view.setUint32(1, streamId >>> 0, false);
  if (payload && size > 0) frame.set(payload, HEADER_BYTES);
  return frame;
}

export function encodeJsonFrame(type: FrameType, streamId: number, data: unknown): Uint8Array {
  return encodeFrame(type, streamId, encoder.encode(JSON.stringify(data)));
}

export function encodeTextFrame(type: FrameType, streamId: number, text: string): Uint8Array {
  return encodeFrame(type, streamId, encoder.encode(text));
}

export function decodeFrame(
  raw: Uint8Array,
): { type: number; streamId: number; payload: Uint8Array } | null {
  if (raw.byteLength < HEADER_BYTES) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, HEADER_BYTES);
  return {
    type: raw[0] ?? 0,
    streamId: view.getUint32(1, false),
    payload: raw.subarray(HEADER_BYTES),
  };
}

export function decodeJsonPayload<T>(
  payload: Uint8Array,
  parse: (value: unknown) => T | null,
): T | null {
  try {
    return parse(JSON.parse(decoder.decode(payload)));
  } catch {
    return null;
  }
}

export function decodeTextPayload(payload: Uint8Array): string {
  return decoder.decode(payload);
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function filterHeaders(
  headers: Record<string, string | string[] | undefined>,
  extraStrip: ReadonlySet<string> = new Set(),
): [string, string][] {
  const connectionValues = new Set<string>();
  const connectionHeader = headers.connection;
  const rawConn = Array.isArray(connectionHeader) ? connectionHeader.join(",") : connectionHeader;
  if (rawConn) {
    for (const token of rawConn.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) connectionValues.add(normalized);
    }
  }
  const entries: [string, string][] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || connectionValues.has(name) || extraStrip.has(name)) continue;
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) entries.push([name, value]);
    } else {
      entries.push([name, rawValue]);
    }
  }
  return entries;
}

export function isRootHtmlNavigation(
  method: string,
  path: string,
  accept: string | undefined,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = path.split("?")[0] ?? "/";
  if (pathname !== "/") return false;
  return Boolean(accept && accept.toLowerCase().includes("text/html"));
}

const RESERVED_WS_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);
const MAX_WS_CLOSE_REASON_BYTES = 123;

export function safeWsCloseCode(code: number | undefined): number {
  if (
    typeof code !== "number" ||
    !Number.isInteger(code) ||
    code < 1000 ||
    code > 4999 ||
    RESERVED_WS_CLOSE_CODES.has(code)
  ) {
    return 1000;
  }
  return code;
}

export function safeWsCloseReason(reason: string | undefined): string {
  if (!reason) return "";
  const bytes = encoder.encode(reason);
  if (bytes.byteLength <= MAX_WS_CLOSE_REASON_BYTES) return reason;
  let end = MAX_WS_CLOSE_REASON_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}
