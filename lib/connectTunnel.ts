import * as v from "valibot";

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
  | typeof FRAME_TICKET_REFRESH;

export const headerEntriesSchema = v.array(v.tuple([v.string(), v.string()]));

export const reqHeadSchema = v.object({
  method: v.string(),
  path: v.string(),
  headers: headerEntriesSchema,
  remoteIp: v.optional(v.string()),
});

export const resHeadSchema = v.object({
  status: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(599)),
  headers: headerEntriesSchema,
});

export const wsOpenSchema = v.object({
  path: v.string(),
  headers: headerEntriesSchema,
  remoteIp: v.optional(v.string()),
});

export const wsAcceptedSchema = v.object({
  protocol: v.optional(v.string()),
});

export const wsCloseSchema = v.object({
  code: v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(4999)),
  reason: v.optional(v.string()),
});

export type ReqHeadPayload = v.InferOutput<typeof reqHeadSchema>;
export type ResHeadPayload = v.InferOutput<typeof resHeadSchema>;
export type WsOpenPayload = v.InferOutput<typeof wsOpenSchema>;
export type WsAcceptedPayload = v.InferOutput<typeof wsAcceptedSchema>;
export type WsClosePayload = v.InferOutput<typeof wsCloseSchema>;

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

export function decodeJsonPayload<Schema extends v.GenericSchema>(
  payload: Uint8Array,
  schema: Schema,
): v.InferOutput<Schema> | null {
  try {
    const parsed = v.safeParse(schema, JSON.parse(decoder.decode(payload)));
    return parsed.success ? parsed.output : null;
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
