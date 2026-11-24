import { isRecord } from "./isRecord.ts";

export const CONNECT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
export const CONNECT_SLUG_HOLD_MS = 90 * 24 * 60 * 60 * 1000;
export const CONNECT_TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
export const CONNECT_TICKET_TTL_MS = 15 * 60 * 1000;
export const CONNECT_ASSERTION_TTL_MS = 60 * 1000;
export const CONNECT_MAX_SERVERS_DEFAULT = 3;
export const CONNECT_MAX_USERS_PER_SERVER = 10;

const CLOCK_SKEW_SECONDS = 30;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ConnectPublicJwk {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface ConnectPrivateJwk {
  kid?: string;
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  d: string;
}

export interface TunnelTicketPayload {
  typ: "aurral-connect-tunnel";
  iss: string;
  aud: "aurral-relay";
  sub: string;
  slug: string;
  connectOrigin: string;
  iat: number;
  exp: number;
}

export interface AuthAssertionPayload {
  typ: "aurral-connect-auth";
  iss: string;
  aud: string;
  sub: string;
  handle: string;
  jti: string;
  iat: number;
  exp: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonEmptyString = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;

export function parseConnectPublicJwk(value: unknown): ConnectPublicJwk | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.kid, 64) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    !BASE64URL_PATTERN.test(value.x)
  ) {
    return null;
  }
  return { kid: value.kid, kty: "OKP", crv: "Ed25519", x: value.x };
}

export function parseConnectPrivateJwk(value: unknown): ConnectPrivateJwk | null {
  if (!isRecord(value)) return null;
  if (value.kid !== undefined && !isNonEmptyString(value.kid, 64)) return null;
  if (
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    !BASE64URL_PATTERN.test(value.x) ||
    typeof value.d !== "string" ||
    !BASE64URL_PATTERN.test(value.d)
  ) {
    return null;
  }
  return {
    ...(value.kid !== undefined && { kid: value.kid }),
    kty: "OKP",
    crv: "Ed25519",
    x: value.x,
    d: value.d,
  };
}

export function parseConnectJwks(value: unknown): { keys: ConnectPublicJwk[] } | null {
  if (!isRecord(value) || !Array.isArray(value.keys)) return null;
  const keys: ConnectPublicJwk[] = [];
  for (const entry of value.keys) {
    const parsed = parseConnectPublicJwk(entry);
    if (!parsed) return null;
    keys.push(parsed);
  }
  return { keys };
}

export function parseTunnelTicket(value: unknown): TunnelTicketPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.typ !== "aurral-connect-tunnel" ||
    !isNonEmptyString(value.iss) ||
    value.aud !== "aurral-relay" ||
    !isNonEmptyString(value.sub, 64) ||
    typeof value.slug !== "string" ||
    !CONNECT_SLUG_PATTERN.test(value.slug) ||
    !isNonEmptyString(value.connectOrigin) ||
    !isFiniteNumber(value.iat) ||
    !isFiniteNumber(value.exp)
  ) {
    return null;
  }
  return {
    typ: "aurral-connect-tunnel",
    iss: value.iss,
    aud: "aurral-relay",
    sub: value.sub,
    slug: value.slug,
    connectOrigin: value.connectOrigin,
    iat: value.iat,
    exp: value.exp,
  };
}

export function parseAuthAssertion(value: unknown): AuthAssertionPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.typ !== "aurral-connect-auth" ||
    !isNonEmptyString(value.iss) ||
    !isNonEmptyString(value.aud, 64) ||
    !isNonEmptyString(value.sub, 128) ||
    !isNonEmptyString(value.handle, 64) ||
    typeof value.jti !== "string" ||
    value.jti.length < 8 ||
    value.jti.length > 128 ||
    !isFiniteNumber(value.iat) ||
    !isFiniteNumber(value.exp)
  ) {
    return null;
  }
  return {
    typ: "aurral-connect-auth",
    iss: value.iss,
    aud: value.aud,
    sub: value.sub,
    handle: value.handle,
    jti: value.jti,
    iat: value.iat,
    exp: value.exp,
  };
}

function parseJwsHeader(value: unknown): { alg: "EdDSA"; kid: string; typ: "JWT" } | null {
  if (!isRecord(value)) return null;
  if (value.alg !== "EdDSA" || value.typ !== "JWT" || !isNonEmptyString(value.kid, 64)) {
    return null;
  }
  return { alg: "EdDSA", kid: value.kid, typ: "JWT" };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

async function computeKid(x: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(x));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function parseEd25519PrivateJwk(
  raw: string,
): Promise<{ privateJwk: ConnectPrivateJwk; publicJwk: ConnectPublicJwk } | null> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = parseConnectPrivateJwk(parsedJson);
  if (!parsed) return null;
  const kid = parsed.kid ?? (await computeKid(parsed.x));
  return {
    privateJwk: { ...parsed, kid },
    publicJwk: { kid, kty: "OKP", crv: "Ed25519", x: parsed.x },
  };
}

export async function generateEd25519KeyPair(): Promise<{
  privateJwk: ConnectPrivateJwk;
  publicJwk: ConnectPublicJwk;
}> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const parsed = parseConnectPrivateJwk(exported);
  if (!parsed) throw new Error("Failed to export Ed25519 key pair");
  const kid = await computeKid(parsed.x);
  return {
    privateJwk: { ...parsed, kid },
    publicJwk: { kid, kty: "OKP", crv: "Ed25519", x: parsed.x },
  };
}

export async function signConnectToken<T extends object>(
  privateJwkRaw: string | ConnectPrivateJwk,
  payload: T,
): Promise<string> {
  const key =
    typeof privateJwkRaw === "string"
      ? await parseEd25519PrivateJwk(privateJwkRaw)
      : {
          privateJwk: {
            ...privateJwkRaw,
            kid: privateJwkRaw.kid ?? (await computeKid(privateJwkRaw.x)),
          },
        };
  if (!key) throw new Error("Invalid Connect Ed25519 signing key");
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: key.privateJwk.kty,
      crv: key.privateJwk.crv,
      x: key.privateJwk.x,
      d: key.privateJwk.d,
    },
    "Ed25519",
    false,
    ["sign"],
  );
  const headerPart = toBase64Url(
    encoder.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: key.privateJwk.kid })),
  );
  const payloadPart = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signingInput = encoder.encode(`${headerPart}.${payloadPart}`);
  const signature = await crypto.subtle.sign("Ed25519", cryptoKey, signingInput);
  return `${headerPart}.${payloadPart}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyConnectToken<
  Payload extends { iss: string; aud: string; iat: number; exp: number },
>(
  token: string,
  keys: readonly ConnectPublicJwk[],
  parsePayload: (value: unknown) => Payload | null,
  options: { expectedIss?: string; expectedAud?: string; nowMs?: number } = {},
): Promise<Payload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return null;

  const headerBytes = fromBase64Url(headerPart);
  const payloadBytes = fromBase64Url(payloadPart);
  const signatureBytes = fromBase64Url(signaturePart);
  if (!headerBytes || !payloadBytes || !signatureBytes) return null;

  let headerJson: unknown;
  let payloadJson: unknown;
  try {
    headerJson = JSON.parse(decoder.decode(headerBytes));
    payloadJson = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }

  const header = parseJwsHeader(headerJson);
  if (!header) return null;
  const matchedKey = keys.find((candidate) => candidate.kid === header.kid);
  if (!matchedKey) return null;

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: matchedKey.kty, crv: matchedKey.crv, x: matchedKey.x },
      "Ed25519",
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  const validSignature = await crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    signatureBytes,
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!validSignature) return null;

  const payload = parsePayload(payloadJson);
  if (!payload) return null;

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS) return null;
  if (payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (options.expectedIss && payload.iss !== options.expectedIss) return null;
  if (options.expectedAud && payload.aud !== options.expectedAud) return null;
  return payload;
}

export function normalizeLanHints(hints: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of hints) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 128) continue;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.username || url.password || url.search || url.hash) continue;
    if (url.pathname && url.pathname !== "/") continue;
    if (seen.has(url.origin)) continue;
    seen.add(url.origin);
    normalized.push(url.origin);
    if (normalized.length >= 8) break;
  }
  return normalized;
}
