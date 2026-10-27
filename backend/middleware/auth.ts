import crypto from "crypto";
import net from "net";
import os from "os";
import { dbOps, userOps } from "../db/helpers/index.ts";
import { createSession, getSessionByToken } from "../config/session-helpers.ts";
import { hashPassword, verifyPassword, needsRehash } from "./passwordHash.ts";
import type { RequestUser } from "./requestUser.ts";
import type { UserPermissions, UserRecord } from "../db/helpers/users.ts";

type RequestHeaders = Record<string, string | string[] | undefined>;

type ClientRequest = {
  headers?: RequestHeaders;
  socket?: { remoteAddress?: string };
  connection?: { remoteAddress?: string };
  ip?: string;
  ips?: string[];
};

type ProxyRequest = ClientRequest & { headers: RequestHeaders };

export type CredentialRequest = ProxyRequest & {
  query?: { api_key?: string; token?: string; st?: string };
};

type ResolvableUser = Pick<
  UserRecord,
  "id" | "username" | "role" | "permissions" | "status" | "isProtected" | "roleSource"
>;

const safeCompare = (a: unknown, b: unknown) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

function createSubsonicToken(password: string, salt: unknown) {
  // Subsonic requires MD5(password + salt) for token authentication; this digest is never stored.
  //
  // codeql[js/insufficient-password-hash]
  return crypto.createHash("md5").update(`${password}${salt}`).digest("hex");
}

const DEFAULT_PROXY_HEADER = "x-forwarded-user";
const STREAM_TOKEN_TTL_MS = 2 * 60 * 1000;
const streamTokenStore = new Map();
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);
const privateLanAddresses = new net.BlockList();
for (const [address, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  privateLanAddresses.addSubnet(address, prefix, "ipv4");
}

const normalizeLocalNetworkBypassSettings = (settings = dbOps.getSettings()) => ({
  enabled: settings?.security?.localNetworkBypass?.enabled === true,
});

const withLocalNetworkBypassDefaults = (settings = dbOps.getSettings()) => ({
  ...settings,
  security: {
    ...(settings?.security || {}),
    localNetworkBypass: {
      enabled: settings?.security?.localNetworkBypass?.enabled === true,
    },
  },
});

export const getAuthUser = () => {
  const settings = dbOps.getSettings();
  return settings.integrations?.general?.authUser || process.env.AUTH_USER || "admin";
};

export const getAuthPassword = () => {
  const settings = dbOps.getSettings();
  const dbPass = settings.integrations?.general?.authPassword;
  if (dbPass) return [dbPass];
  return process.env.AUTH_PASSWORD ? process.env.AUTH_PASSWORD.split(",").map((p) => p.trim()) : [];
};

const API_KEY_SETTINGS_KEY = "apiKey";

export const getApiKey = () => {
  const settings = dbOps.getSettings();
  const existing = settings.integrations?.general?.[API_KEY_SETTINGS_KEY];
  if (existing && typeof existing === "string" && existing.length >= 32) return existing;
  const key = crypto.randomBytes(32).toString("hex");
  const next = {
    ...settings,
    integrations: {
      ...(settings.integrations || {}),
      general: {
        ...(settings.integrations?.general || {}),
        [API_KEY_SETTINGS_KEY]: key,
      },
    },
  };
  dbOps.updateSettings(next);
  return key;
};

export const rotateApiKey = () => {
  const settings = dbOps.getSettings();
  const key = crypto.randomBytes(32).toString("hex");
  const next = {
    ...settings,
    integrations: {
      ...(settings.integrations || {}),
      general: {
        ...(settings.integrations?.general || {}),
        [API_KEY_SETTINGS_KEY]: key,
      },
    },
  };
  dbOps.updateSettings(next);
  return key;
};

export const isProxyAuthEnabled = () => {
  if (process.env.AUTH_PROXY_ENABLED !== undefined) {
    return process.env.AUTH_PROXY_ENABLED === "true";
  }
  return !!process.env.AUTH_PROXY_HEADER;
};

function parseCsv(value: string | undefined) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getProxyHeaderName() {
  const header = process.env.AUTH_PROXY_HEADER || DEFAULT_PROXY_HEADER;
  return String(header).trim().toLowerCase();
}

function getHeaderValue(req: ProxyRequest, headerName: string) {
  const value = req.headers[headerName];
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeIp(value: string | null | undefined) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  const withoutBrackets = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return withoutBrackets.startsWith("::ffff:") ? withoutBrackets.slice(7) : withoutBrackets;
}

function isLoopbackIp(ip: string) {
  return LOOPBACK_IPS.has(normalizeIp(ip));
}

function isPrivateIpv4(ip: string) {
  return net.isIPv4(ip) && privateLanAddresses.check(ip, "ipv4");
}

function getPrivateIpv4Subnets() {
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return [];
  }
  const subnets = [];
  for (const details of Object.values(interfaces)) {
    for (const detail of details || []) {
      if (!detail || detail.internal || detail.family !== "IPv4") continue;
      const address = normalizeIp(detail.address);
      const prefix = Number(String(detail.cidr || "").split("/")[1]);
      if (!isPrivateIpv4(address) || !Number.isInteger(prefix)) continue;
      const subnet = new net.BlockList();
      subnet.addSubnet(address, prefix, "ipv4");
      subnets.push({ address, prefix, subnet });
    }
  }
  return subnets;
}

export function inferTrustedLocalSubnet() {
  const [first, ...others] = getPrivateIpv4Subnets();
  if (!first) return null;
  const sameSubnet = others.every(
    (other) => other.prefix === first.prefix && first.subnet.check(other.address, "ipv4"),
  );
  return sameSubnet ? first.subnet : null;
}

function getRequestIps(req: ClientRequest) {
  const ips = [
    req?.socket?.remoteAddress,
    req?.connection?.remoteAddress,
    req?.ip,
    ...(Array.isArray(req?.ips) ? req.ips : []),
  ]
    .map((ip) => normalizeIp(ip))
    .filter(Boolean);
  return Array.from(new Set(ips));
}

function isTrustedProxy(req: ClientRequest) {
  const allowed = parseCsv(process.env.AUTH_PROXY_TRUSTED_IPS).map((ip) => normalizeIp(ip));
  if (allowed.length === 0) return true;
  const requestIps = getRequestIps(req);
  return requestIps.some((ip) => allowed.includes(ip));
}

function buildPermissions(role: string, permissions?: UserPermissions) {
  if (role === "admin") {
    return {
      accessSettings: true,
      accessFlow: true,
      addArtist: true,
      addAlbum: true,
      changeMonitoring: true,
      deleteArtist: true,
      deleteAlbum: true,
      deleteTrack: true,
    };
  }
  return {
    ...userOps.getDefaultPermissions(),
    ...(permissions || {}),
    accessSettings: false,
  };
}

export function toResolvedUser(user: ResolvableUser | null) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: buildPermissions(user.role, user.permissions),
    status: user.status || "active",
    isProtected: !!user.isProtected,
    roleSource: user.roleSource || "local",
  };
}

const toSessionUser = (session: ReturnType<typeof getSessionByToken>) => {
  if (!session?.user) return null;
  const baseUser = session.user;
  return {
    id: baseUser.id,
    username: baseUser.username,
    role: baseUser.role,
    permissions: buildPermissions(baseUser.role, baseUser.permissions),
  };
};

const getBearerToken = (authorization: string | undefined) => {
  const authHeader = String(authorization || "");
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
};

export function isRecentlyAuthenticated(authorization: string | undefined, maxAgeMinutes = 15) {
  const session = getSessionByToken(getBearerToken(authorization));
  if (!session) return false;
  return Date.now() - session.reauthenticatedAt <= maxAgeMinutes * 60 * 1000;
}

export function getUnauthorizedDetails(authorization: string | undefined) {
  if (getBearerToken(authorization)) {
    return {
      code: "SESSION_INVALID",
      message: "Session expired or invalid",
    };
  }
  return {
    code: "AUTH_REQUIRED",
    message: "Authentication required",
  };
}

export const resolveSessionUserFromToken = (token: unknown) => {
  if (!token) return null;
  return toSessionUser(getSessionByToken(token));
};

function resolveApiKeyUser(req: CredentialRequest) {
  const headerKey = (getHeaderValue(req, "x-api-key") || "").trim();
  const queryKey = req.query?.api_key?.trim() || "";
  const incoming = headerKey || queryKey;
  if (!incoming) return null;
  try {
    const storedKey = getApiKey();
    if (safeCompare(incoming, storedKey)) {
      return {
        id: -1,
        username: "api",
        role: "admin",
        permissions: buildPermissions("admin"),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export const isOidcAuthEnabled = () => process.env.OIDC_ENABLED === "true";

export const isAuthRequiredByConfig = () => {
  const settings = dbOps.getSettings();
  const onboardingDone = settings.onboardingComplete;
  if (!onboardingDone) return false;
  const legacyPasswords = getAuthPassword();
  return (
    isProxyAuthEnabled() ||
    isOidcAuthEnabled() ||
    userOps.countUsers() > 0 ||
    legacyPasswords.length > 0
  );
};

export const getLocalNetworkBypassConfig = (settings = dbOps.getSettings()) =>
  normalizeLocalNetworkBypassSettings(settings);

export function getSoleAdminUser() {
  if (userOps.countUsers() !== 1) return null;
  const [user] = userOps.getAllUsers();
  if (user?.role !== "admin") return null;
  return user;
}

export function isRequestFromTrustedLocalSubnet(req: ClientRequest) {
  const requestIps = getRequestIps(req);
  if (requestIps.some((ip) => isLoopbackIp(ip))) {
    return true;
  }
  const subnet = inferTrustedLocalSubnet();
  if (!subnet) return false;
  return requestIps.some((ip) => isPrivateIpv4(ip) && subnet.check(ip, "ipv4"));
}

export function getLocalNetworkBypassStatus(req: ClientRequest) {
  const settings = dbOps.getSettings();
  const config = getLocalNetworkBypassConfig(settings);
  const onboardingDone = settings?.onboardingComplete === true;
  const userCount = userOps.countUsers();
  const soleUser = userCount === 1 ? userOps.getAllUsers()[0] : null;
  const soleAdminUser = soleUser?.role === "admin" ? soleUser : null;
  const subnet = inferTrustedLocalSubnet();

  let eligible = true;
  let reason = null;

  if (!onboardingDone) {
    eligible = false;
    reason = "not_onboarded";
  } else if (userCount !== 1) {
    eligible = false;
    reason = "not_single_user";
  } else if (!soleUser || soleUser.role !== "admin") {
    eligible = false;
    reason = "sole_user_not_admin";
  } else if (!subnet) {
    eligible = false;
    reason = "not_trusted_network";
  }

  const active =
    config.enabled && eligible && isRequestFromTrustedLocalSubnet(req) && !!soleAdminUser;

  return {
    enabled: config.enabled,
    eligible,
    active,
    reason: reason || (config.enabled ? null : "disabled"),
  };
}

export function reconcileLocalNetworkBypassSetting() {
  const currentSettings = dbOps.getSettings();
  const current = getLocalNetworkBypassConfig(currentSettings);
  if (!current.enabled) {
    return {
      changed: false,
      settings: withLocalNetworkBypassDefaults(currentSettings),
    };
  }
  const status = getLocalNetworkBypassStatus({
    headers: {},
    socket: {},
    connection: {},
    ip: "",
    ips: [],
  });
  if (status.eligible) {
    return {
      changed: false,
      settings: withLocalNetworkBypassDefaults(currentSettings),
    };
  }
  const nextSettings = withLocalNetworkBypassDefaults(currentSettings);
  nextSettings.security.localNetworkBypass.enabled = false;
  dbOps.updateSettings(nextSettings);
  return {
    changed: true,
    settings: nextSettings,
  };
}

export function createSystemProvisionedUser(username: string, role: string) {
  const passwordHash = hashPassword(crypto.randomBytes(32).toString("hex"));
  const created = userOps.createUser(username, passwordHash, role, null, false);
  return created
    ? toResolvedUser(userOps.getUserByUsername(created.username) || created)
    : toResolvedUser(userOps.getUserByUsername(username));
}

export function ensureExternalUser(username: string, role: string) {
  const existing = userOps.getUserByUsername(username);
  if (existing) {
    if (existing.isProtected) {
      return toResolvedUser(existing);
    }
    if (existing.role !== role) {
      const updated = userOps.updateUser(existing.id, { role, roleSource: "local" });
      return toResolvedUser(updated || existing);
    }
    return toResolvedUser(existing);
  }
  return createSystemProvisionedUser(username, role);
}

function isProxyAdmin(req: ProxyRequest, username: string) {
  const adminUsers = parseCsv(process.env.AUTH_PROXY_ADMIN_USERS).map((u) => u.toLowerCase());
  if (adminUsers.includes(username.toLowerCase())) return true;

  const headerRoleName = process.env.AUTH_PROXY_ROLE_HEADER
    ? String(process.env.AUTH_PROXY_ROLE_HEADER).trim().toLowerCase()
    : "";
  if (!headerRoleName) return false;

  const groups = String(getHeaderValue(req, headerRoleName) || "")
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);

  const adminGroups = parseCsv(process.env.AUTH_PROXY_ADMIN_GROUPS).map((g) => g.toLowerCase());
  return groups.some((g) => adminGroups.includes(g));
}

function resolveProxyRole(req: ProxyRequest, username: string) {
  const defaultRole =
    (process.env.AUTH_PROXY_DEFAULT_ROLE || "user").trim().toLowerCase() === "admin"
      ? "admin"
      : "user";
  return isProxyAdmin(req, username) ? "admin" : defaultRole;
}

export function resolveProxyUser(req: ProxyRequest) {
  if (!isProxyAuthEnabled()) return null;
  if (!isTrustedProxy(req)) return null;
  const headerName = getProxyHeaderName();
  const rawUsername = getHeaderValue(req, headerName);
  const username = String(rawUsername || "").trim();
  if (!username) return null;

  const role = resolveProxyRole(req, username);
  const user = ensureExternalUser(username, role);
  return user?.status === "active" ? user : null;
}

export function issueProxySession(req: CredentialRequest) {
  if (!isAuthRequiredByConfig()) return null;
  if (resolveSessionUserFromToken(getBearerToken(getHeaderValue(req, "authorization")))) {
    return null;
  }
  const proxyUser = resolveProxyUser(req);
  if (!proxyUser?.id || proxyUser.id < 0) return null;
  return createSession(proxyUser.id, req.ip || null, getHeaderValue(req, "user-agent") || null);
}

export function migrateLegacyAdmin() {
  if (userOps.countUsers() > 0) return;
  const settings = dbOps.getSettings();
  const onboardingComplete = settings.onboardingComplete;
  const authUser = settings.integrations?.general?.authUser || "admin";
  const authPassword = settings.integrations?.general?.authPassword;
  if (!onboardingComplete || !authPassword) return;
  const hash = hashPassword(authPassword);
  userOps.createUser(authUser, hash, "admin", null, true, true, authPassword);
}

export function resolveUser(username: string, password: string) {
  if (userOps.countUsers() === 0) {
    migrateLegacyAdmin();
    if (userOps.countUsers() === 0) return null;
  }
  const un = String(username || "")
    .trim()
    .toLowerCase();
  const u = userOps.getUserByUsername(un);
  if (!u || u.status !== "active" || !password) return null;
  const storedPassword = userOps.getSubsonicPasswordById(u.id);
  if (!storedPassword || !safeCompare(password, storedPassword)) {
    if (!verifyPassword(password, u.passwordHash)) return null;
    if (needsRehash(u.passwordHash)) {
      userOps.updateUser(u.id, {
        passwordHash: hashPassword(password),
        subsonicPassword: password,
      });
    } else {
      userOps.syncSubsonicPassword(u.id, password);
    }
  }
  const perms = buildPermissions(u.role, u.permissions);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    permissions: perms,
  };
}

export function resolveSubsonicTokenUser(username: string, token: unknown, salt: unknown) {
  if (!/^[a-f\d]{32}$/i.test(String(token || "")) || !String(salt || "")) return null;
  if (userOps.countUsers() === 0) migrateLegacyAdmin();
  const normalizedUsername = String(username || "")
    .trim()
    .toLowerCase();
  const user = userOps.getUserByUsername(normalizedUsername);
  if (!user) return null;

  let password: string | null | undefined = userOps.getSubsonicPasswordById(user.id);
  if (!password && safeCompare(normalizedUsername, String(getAuthUser()).trim().toLowerCase())) {
    password = getAuthPassword().find((candidate) =>
      safeCompare(createSubsonicToken(candidate, salt), token),
    );
  }
  if (!password) return null;

  const expectedToken = createSubsonicToken(password, salt);
  return safeCompare(expectedToken, token) ? resolveUser(normalizedUsername, password) : null;
}

function legacyAuth(username: string, password: string) {
  const authUser = getAuthUser();
  const passwords = getAuthPassword();
  if (passwords.length === 0) return null;
  const userMatches = safeCompare(username, authUser);
  const passwordMatches = passwords.some((p) => safeCompare(password, p));
  if (!userMatches || !passwordMatches) return null;
  return {
    id: 0,
    username: authUser,
    role: "admin",
    permissions: {
      accessSettings: true,
      accessFlow: true,
      addArtist: true,
      addAlbum: true,
      changeMonitoring: true,
      deleteArtist: true,
      deleteAlbum: true,
      deleteTrack: true,
    },
  };
}

export function resolveLocalNetworkBypassUser(req: ClientRequest) {
  const status = getLocalNetworkBypassStatus(req);
  if (!status.active) return null;
  const user = getSoleAdminUser();
  return user?.status === "active" ? toResolvedUser(user) : null;
}

export function resolveRequestUser(req: CredentialRequest) {
  const authHeader = getHeaderValue(req, "authorization");
  const sessionUser = resolveSessionUserFromToken(getBearerToken(authHeader));
  if (sessionUser) return sessionUser;
  const proxyUser = resolveProxyUser(req);
  if (proxyUser) return proxyUser;
  const apiKeyUser = resolveApiKeyUser(req);
  if (apiKeyUser) return apiKeyUser;
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const token = authHeader.substring(6);
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const username = colon >= 0 ? decoded.slice(0, colon) : decoded;
      const password = colon >= 0 ? decoded.slice(colon + 1) : "";
      let user = resolveUser(username, password);
      if (!user && userOps.countUsers() === 0) user = legacyAuth(username, password);
      if (user) return user;
    } catch (e) {
      return null;
    }
  }
  return resolveLocalNetworkBypassUser(req);
}

function pruneExpiredStreamTokens() {
  const now = Date.now();
  for (const [token, payload] of streamTokenStore.entries()) {
    if (!payload || payload.expiresAt <= now) {
      streamTokenStore.delete(token);
    }
  }
}

export function issueStreamToken(user: RequestUser | null, ttlMs = STREAM_TOKEN_TTL_MS) {
  if (!user) return null;
  pruneExpiredStreamTokens();
  const token = crypto.randomBytes(24).toString("base64url");
  streamTokenStore.set(token, {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions: user.permissions || {},
    },
    expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || STREAM_TOKEN_TTL_MS),
  });
  return token;
}

function consumeStreamToken(rawToken: unknown) {
  if (!rawToken) return null;
  pruneExpiredStreamTokens();
  const token = String(rawToken).trim();
  if (!token) return null;
  const payload = streamTokenStore.get(token);
  if (!payload || payload.expiresAt <= Date.now()) {
    streamTokenStore.delete(token);
    return null;
  }
  return payload.user || null;
}

function resolveBasicUser(authorization: string | undefined) {
  if (!authorization?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  const username = colon >= 0 ? decoded.slice(0, colon) : decoded;
  const password = colon >= 0 ? decoded.slice(colon + 1) : "";
  return resolveUser(username, password) || legacyAuth(username, password);
}

export const resolveTokenUser = (req: CredentialRequest) =>
  resolveRequestUser(req) ||
  resolveSessionUserFromToken(req.query?.token) ||
  resolveBasicUser(getHeaderValue(req, "authorization")) ||
  consumeStreamToken(req.query?.st);

export function hasPermission(
  user: Pick<RequestUser, "role" | "permissions"> | null | undefined,
  permission: string,
) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return !!user.permissions?.[permission];
}

export const requirePasswordStrength = (password: unknown) => {
  const raw = String(password || "");
  if (raw.length < 8) {
    return {
      valid: false,
      error: "Password must be at least 8 characters long",
    };
  }
  return { valid: true };
};
