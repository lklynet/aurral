import crypto from "crypto";

const STATE_TTL_MS = 10 * 60 * 1000;
const TRANSACTION_COOKIE = "aurral_plex_login_transaction";
type PendingPlexLogin = {
  pinId: string | number;
  code: string;
  clientId: string;
  expiresAt: number;
};

const pendingLogins = new Map<string, PendingPlexLogin>();

function prunePendingLogins(now = Date.now()) {
  for (const [transactionId, entry] of pendingLogins) {
    if (!entry || entry.expiresAt <= now) pendingLogins.delete(transactionId);
  }
}

export function readPlexLoginTransaction(cookieHeader: string | undefined) {
  const cookies = String(cookieHeader || "").split(";");
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split("=");
    if (name !== TRANSACTION_COOKIE) continue;
    try {
      return decodeURIComponent(parts.join("="));
    } catch {
      return "";
    }
  }
  return "";
}

function transactionCookie(value: string, secure: boolean, maxAge: number) {
  const attributes = [
    `${TRANSACTION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  attributes.push(`Max-Age=${maxAge}`);
  return attributes.join("; ");
}

export const clearedPlexLoginCookie = (secure: boolean) => transactionCookie("", secure, 0);

export function isSafeForwardUrl(forwardUrl: unknown) {
  const value = String(forwardUrl || "");
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const base = "https://aurral.invalid";
    return new URL(value, base).origin === base;
  } catch {
    return false;
  }
}

export async function startPlexLogin(forwardUrl: string | null | undefined, secure: boolean) {
  const { PlexClient } = await import("./plex.ts");
  const clientId = PlexClient.generateClientId();
  const { id: pinId, code } = await PlexClient.generatePin(clientId);
  const transactionId = crypto.randomBytes(24).toString("hex");

  prunePendingLogins();
  pendingLogins.set(transactionId, {
    pinId,
    code,
    clientId,
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  return {
    authUrl: PlexClient.buildAuthUrl(clientId, code, forwardUrl),
    cookie: transactionCookie(transactionId, secure, Math.floor(STATE_TTL_MS / 1000)),
  };
}

export function getPendingPlexLogin(transactionId: string) {
  prunePendingLogins();
  const pending = transactionId ? pendingLogins.get(transactionId) : null;
  return pending && pending.expiresAt > Date.now() ? pending : null;
}

export function endPlexLogin(transactionId: string) {
  pendingLogins.delete(transactionId);
}
