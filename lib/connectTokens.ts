import * as v from "valibot";

export const CONNECT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
export const CONNECT_SLUG_HOLD_MS = 90 * 24 * 60 * 60 * 1000;
export const CONNECT_TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
export const CONNECT_TICKET_TTL_MS = 15 * 60 * 1000;
export const CONNECT_ASSERTION_TTL_MS = 60 * 1000;
export const CONNECT_MAX_SERVERS_DEFAULT = 3;
export const CONNECT_MAX_USERS_PER_SERVER = 10;

const CLOCK_SKEW_SECONDS = 30;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const connectJwkSchema = v.object({
  kid: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  kty: v.literal("OKP"),
  crv: v.literal("Ed25519"),
  x: v.pipe(v.string(), v.regex(BASE64URL_PATTERN)),
});

export const connectPrivateJwkSchema = v.object({
  kid: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  kty: v.literal("OKP"),
  crv: v.literal("Ed25519"),
  x: v.pipe(v.string(), v.regex(BASE64URL_PATTERN)),
  d: v.pipe(v.string(), v.regex(BASE64URL_PATTERN)),
});

export const connectJwksSchema = v.object({
  keys: v.array(connectJwkSchema),
});

export const tunnelTicketSchema = v.object({
  typ: v.literal("aurral-connect-tunnel"),
  iss: v.string(),
  aud: v.literal("aurral-relay"),
  sub: v.string(),
  slug: v.pipe(v.string(), v.regex(CONNECT_SLUG_PATTERN)),
  connectOrigin: v.string(),
  iat: v.number(),
  exp: v.number(),
});

export const authAssertionSchema = v.object({
  typ: v.literal("aurral-connect-auth"),
  iss: v.string(),
  aud: v.string(),
  sub: v.string(),
  handle: v.string(),
  jti: v.pipe(v.string(), v.minLength(8), v.maxLength(128)),
  iat: v.number(),
  exp: v.number(),
});

const jwsHeaderSchema = v.object({
  alg: v.literal("EdDSA"),
  kid: v.string(),
  typ: v.literal("JWT"),
});

export type ConnectPublicJwk = v.InferOutput<typeof connectJwkSchema>;
export type ConnectPrivateJwk = v.InferOutput<typeof connectPrivateJwkSchema>;
export type TunnelTicketPayload = v.InferOutput<typeof tunnelTicketSchema>;
export type AuthAssertionPayload = v.InferOutput<typeof authAssertionSchema>;

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
  const parsed = v.safeParse(connectPrivateJwkSchema, parsedJson);
  if (!parsed.success) return null;
  const kid = parsed.output.kid ?? (await computeKid(parsed.output.x));
  return {
    privateJwk: { ...parsed.output, kid },
    publicJwk: { kid, kty: "OKP", crv: "Ed25519", x: parsed.output.x },
  };
}

export async function generateEd25519KeyPair(): Promise<{
  privateJwk: ConnectPrivateJwk;
  publicJwk: ConnectPublicJwk;
}> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const parsed = v.parse(connectPrivateJwkSchema, exported);
  const kid = await computeKid(parsed.x);
  return {
    privateJwk: { ...parsed, kid },
    publicJwk: { kid, kty: "OKP", crv: "Ed25519", x: parsed.x },
  };
}

export async function signConnectToken<T extends Record<string, unknown>>(
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
  Schema extends v.GenericSchema<unknown, { iss: string; aud: string; iat: number; exp: number }>,
>(
  token: string,
  keys: readonly ConnectPublicJwk[],
  schema: Schema,
  options: { expectedIss?: string; expectedAud?: string; nowMs?: number } = {},
): Promise<v.InferOutput<Schema> | null> {
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

  const header = v.safeParse(jwsHeaderSchema, headerJson);
  if (!header.success) return null;
  const matchedKey = keys.find((candidate) => candidate.kid === header.output.kid);
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

  const payload = v.safeParse(schema, payloadJson);
  if (!payload.success) return null;

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (payload.output.exp <= nowSeconds - CLOCK_SKEW_SECONDS) return null;
  if (payload.output.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (options.expectedIss && payload.output.iss !== options.expectedIss) return null;
  if (options.expectedAud && payload.output.aud !== options.expectedAud) return null;
  return payload.output;
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
