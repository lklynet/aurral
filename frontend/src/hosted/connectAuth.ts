import { isRecord } from "../../../lib/isRecord.ts";

export const HUB_ORIGIN = (import.meta.env.VITE_HUB_ORIGIN || "https://aurral.org").replace(
  /\/+$/,
  "",
);

const SESSION_KEY = "aurral.connect.session";
const PKCE_KEY = "aurral.connect.pkce";
const LOGIN_NOTICE_KEY = "aurral.connect.login-notice";

export interface ConnectSession {
  token: string;
  expiresAt: number;
  handle: string | null;
}

export interface ConnectDiscoveredServer {
  instanceId: string;
  name: string;
  slug: string;
  connectUrl: string;
  lanHints: string[];
  localUserName: string;
  online: boolean;
  lastSeenAt: number | null;
  isOwner: boolean;
}

export interface ConnectDiscoveryResult {
  account: { id: string; handle: string | null };
  servers: ConnectDiscoveredServer[];
}

export type ConnectExchangeResult =
  | { ok: true; sessionToken: string; username: string }
  | {
      ok: false;
      reason:
        | "sign_in_off"
        | "account_not_linked"
        | "ambiguous_link"
        | "offline"
        | "rate_limited"
        | "subscription_required"
        | "unauthorized"
        | "failed";
    };

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}

export const connectRedirectUri = () => `${window.location.origin}/connect/callback`;

export function readConnectSession(): ConnectSession | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (
      isRecord(parsed) &&
      typeof parsed.token === "string" &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt > Date.now()
    ) {
      return {
        token: parsed.token,
        expiresAt: parsed.expiresAt,
        handle: typeof parsed.handle === "string" ? parsed.handle : null,
      };
    }
  } catch {}
  return null;
}

export function writeConnectSession(session: ConnectSession | null) {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function setHostedLoginNotice(address: string, message: string) {
  try {
    sessionStorage.setItem(LOGIN_NOTICE_KEY, JSON.stringify({ address, message }));
  } catch {}
}

export function consumeHostedLoginNotice(address: string): string | null {
  try {
    const raw = sessionStorage.getItem(LOGIN_NOTICE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(LOGIN_NOTICE_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      parsed.address === address &&
      typeof parsed.message === "string" &&
      parsed.message.trim()
    ) {
      return parsed.message;
    }
  } catch {}
  return null;
}

export async function startConnectSignIn() {
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomBase64Url(16);
  const redirectUri = connectRedirectUri();
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ codeVerifier, state, redirectUri }));
  const url = new URL(`${HUB_ORIGIN}/connect/authorize`);
  url.searchParams.set("client_id", "hosted");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("state", state);
  window.location.assign(url.toString());
}

export async function completeConnectCallback(
  code: string,
  state: string,
): Promise<{ ok: true; session: ConnectSession } | { ok: false }> {
  let stored: unknown = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
    sessionStorage.removeItem(PKCE_KEY);
  } catch {
    return { ok: false };
  }
  if (
    !isRecord(stored) ||
    typeof stored.codeVerifier !== "string" ||
    typeof stored.state !== "string" ||
    typeof stored.redirectUri !== "string" ||
    stored.state !== state
  ) {
    return { ok: false };
  }

  const response = await fetch(`${HUB_ORIGIN}/v1/connect/token`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      codeVerifier: stored.codeVerifier,
      redirectUri: stored.redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const body: unknown = response?.ok ? await response.json().catch(() => null) : null;
  if (!isRecord(body) || typeof body.token !== "string" || typeof body.expiresAt !== "number") {
    return { ok: false };
  }
  const session: ConnectSession = { token: body.token, expiresAt: body.expiresAt, handle: null };
  writeConnectSession(session);
  return { ok: true, session };
}

const parseDiscoveredServer = (value: unknown): ConnectDiscoveredServer | null => {
  if (
    !isRecord(value) ||
    typeof value.instanceId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.connectUrl !== "string" ||
    typeof value.localUserName !== "string" ||
    typeof value.online !== "boolean"
  ) {
    return null;
  }
  const lanHints = Array.isArray(value.lanHints)
    ? value.lanHints.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    instanceId: value.instanceId,
    name: value.name,
    slug: value.slug,
    connectUrl: value.connectUrl,
    lanHints,
    localUserName: value.localUserName,
    online: value.online,
    lastSeenAt: typeof value.lastSeenAt === "number" ? value.lastSeenAt : null,
    isOwner: value.isOwner === true,
  };
};

export async function fetchConnectServers(
  token: string,
): Promise<
  { ok: true; data: ConnectDiscoveryResult } | { ok: false; reason: "unauthorized" | "failed" }
> {
  const response = await fetch(`${HUB_ORIGIN}/v1/connect/servers`, {
    method: "GET",
    credentials: "omit",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response) return { ok: false, reason: "failed" };
  if (response.status === 401) {
    writeConnectSession(null);
    return { ok: false, reason: "unauthorized" };
  }
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  if (!isRecord(body) || !isRecord(body.account) || !Array.isArray(body.servers)) {
    return { ok: false, reason: "failed" };
  }
  const handle = typeof body.account.handle === "string" ? body.account.handle : null;
  const id = typeof body.account.id === "string" ? body.account.id : "";
  const existing = readConnectSession();
  if (existing && existing.token === token && existing.handle !== handle) {
    writeConnectSession({ ...existing, handle });
  }
  const servers = body.servers
    .map(parseDiscoveredServer)
    .filter((entry): entry is ConnectDiscoveredServer => entry !== null);
  return { ok: true, data: { account: { id, handle }, servers } };
}

export async function signOutConnect() {
  const session = readConnectSession();
  writeConnectSession(null);
  if (!session) return;
  await fetch(`${HUB_ORIGIN}/v1/connect/sign-out`, {
    method: "POST",
    credentials: "omit",
    headers: { Authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}

export async function exchangeServerSession(
  clientToken: string,
  server: Pick<ConnectDiscoveredServer, "instanceId" | "connectUrl">,
): Promise<ConnectExchangeResult> {
  const assertionRes = await fetch(`${HUB_ORIGIN}/v1/connect/assertions`, {
    method: "POST",
    credentials: "omit",
    headers: {
      Authorization: `Bearer ${clientToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ instanceId: server.instanceId }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!assertionRes) return { ok: false, reason: "failed" };
  if (assertionRes.status === 401) {
    writeConnectSession(null);
    return { ok: false, reason: "unauthorized" };
  }
  const assertionBody: unknown = await assertionRes.json().catch(() => null);
  if (!assertionRes.ok) {
    const code =
      isRecord(assertionBody) && typeof assertionBody.error === "string" ? assertionBody.error : "";
    if (code === "subscription_required") return { ok: false, reason: "subscription_required" };
    if (code === "server_not_linked") return { ok: false, reason: "account_not_linked" };
    return { ok: false, reason: "failed" };
  }
  if (!isRecord(assertionBody) || typeof assertionBody.token !== "string") {
    return { ok: false, reason: "failed" };
  }

  const exchangeRes = await fetch(`${server.connectUrl}/api/auth/connect-exchange`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assertion: assertionBody.token }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!exchangeRes) return { ok: false, reason: "offline" };
  if (exchangeRes.status === 503) return { ok: false, reason: "offline" };
  if (exchangeRes.status === 429) return { ok: false, reason: "rate_limited" };

  const exchangeBody: unknown = await exchangeRes.json().catch(() => null);
  if (!exchangeRes.ok) {
    const code =
      isRecord(exchangeBody) && typeof exchangeBody.error === "string" ? exchangeBody.error : "";
    if (code === "connect_sign_in_disabled") return { ok: false, reason: "sign_in_off" };
    if (code === "account_not_linked") return { ok: false, reason: "account_not_linked" };
    if (code === "ambiguous_account_link") return { ok: false, reason: "ambiguous_link" };
    return { ok: false, reason: "failed" };
  }

  const user = isRecord(exchangeBody) && isRecord(exchangeBody.user) ? exchangeBody.user : null;
  if (
    !isRecord(exchangeBody) ||
    typeof exchangeBody.token !== "string" ||
    typeof user?.username !== "string"
  ) {
    return { ok: false, reason: "failed" };
  }
  return { ok: true, sessionToken: exchangeBody.token, username: user.username };
}
