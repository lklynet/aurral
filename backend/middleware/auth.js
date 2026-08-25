import crypto from "crypto";
import os from "os";
import { dbOps, userOps } from "../db/helpers/index.js";
import {
  createAuthSession,
  getSessionForHeaders,
} from "../services/betterAuth.js";
import { hashPassword, verifyPassword, needsRehash } from "./passwordHash.js";

const safeCompare = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

const DEFAULT_PROXY_HEADER = "x-forwarded-user";
const STREAM_TOKEN_TTL_MS = 2 * 60 * 1000;
const streamTokenStore = new Map();
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

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
  if (process.env.AUTH_PROXY_ENABLED === "true") return true;
  return !!process.env.AUTH_PROXY_HEADER;
};

function parseCsv(value) {
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

function getHeaderValue(req, headerName) {
  const value = req.headers[headerName];
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeIp(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  const withoutBrackets = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return withoutBrackets.startsWith("::ffff:") ? withoutBrackets.slice(7) : withoutBrackets;
}

function isLoopbackIp(ip) {
  return LOOPBACK_IPS.has(normalizeIp(ip));
}

function isPrivateIpv4(ip) {
  const parts = String(ip || "")
    .trim()
    .split(".")
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function ipv4ToInt(ip) {
  const parts = String(ip || "")
    .trim()
    .split(".")
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return null;
  }
  return (
    (((parts[0] << 24) >>> 0) +
      ((parts[1] << 16) >>> 0) +
      ((parts[2] << 8) >>> 0) +
      (parts[3] >>> 0)) >>>
    0
  );
}

function parseNetmaskPrefix(netmask) {
  const maskInt = ipv4ToInt(netmask);
  if (maskInt == null) return null;
  let prefix = 0;
  let sawZero = false;
  for (let bit = 31; bit >= 0; bit -= 1) {
    const set = (maskInt & (1 << bit)) !== 0;
    if (set && sawZero) return null;
    if (set) {
      prefix += 1;
    } else {
      sawZero = true;
    }
  }
  return prefix;
}

function buildIpv4Subnet(address, netmask, interfaceName) {
  const ipInt = ipv4ToInt(address);
  const maskInt = ipv4ToInt(netmask);
  const prefix = parseNetmaskPrefix(netmask);
  if (ipInt == null || maskInt == null || prefix == null) return null;
  const networkInt = (ipInt & maskInt) >>> 0;
  return {
    interfaceName,
    address,
    netmask,
    prefix,
    networkInt,
    key: `${networkInt}/${prefix}`,
  };
}

function getIpv4SubnetCandidates() {
  let interfaces;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return [];
  }
  const candidates = [];
  for (const [name, details] of Object.entries(interfaces)) {
    for (const detail of details || []) {
      if (!detail || detail.internal) continue;
      if (detail.family !== "IPv4") continue;
      const normalizedAddress = normalizeIp(detail.address);
      if (!isPrivateIpv4(normalizedAddress)) continue;
      const subnet = buildIpv4Subnet(normalizedAddress, detail.netmask, name);
      if (subnet) {
        candidates.push(subnet);
      }
    }
  }
  candidates.sort((a, b) =>
    `${a.interfaceName}:${a.address}`.localeCompare(`${b.interfaceName}:${b.address}`),
  );
  return candidates;
}

export function inferTrustedLocalSubnet() {
  const candidates = getIpv4SubnetCandidates();
  if (candidates.length === 0) return null;
  const unique = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  if (unique.size !== 1) return null;
  return Array.from(unique.values())[0];
}

function getRequestIps(req) {
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

function isTrustedProxy(req) {
  const allowed = parseCsv(process.env.AUTH_PROXY_TRUSTED_IPS).map((ip) => normalizeIp(ip));
  if (allowed.length === 0) return true;
  const requestIps = getRequestIps(req);
  return requestIps.some((ip) => allowed.includes(ip));
}

function buildPermissions(role, permissions) {
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

function getProxyIdentity(username) {
  const normalized = String(username || "").trim().toLowerCase();
  const key = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return {
    name: normalized,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
      ? normalized
      : `proxy-${key}@aurral.invalid`,
  };
}

function toResolvedUser(user) {
  if (!user) return null;
  return {
    id: Number(user.id),
    username: user.username,
    role: user.role,
    permissions: buildPermissions(user.role, user.permissions),
  };
}

const toSessionUser = (session) => {
  if (!session?.user) return null;
  const baseUser = session.user;
  return {
    id: Number(baseUser.id),
    username: baseUser.username,
    role: baseUser.role,
    permissions: buildPermissions(baseUser.role, baseUser.permissions),
  };
};

async function getBetterAuthUser(headers) {
  try {
    return toSessionUser(await getSessionForHeaders(headers));
  } catch {
    return null;
  }
}

function getBearerHeaders(token, headers = {}) {
  return {
    ...headers,
    authorization: `Bearer ${String(token || "").trim()}`,
  };
}

async function hydrateBetterAuthUser(req, { queryToken = false } = {}) {
  if (req.user) return req.user;
  const token = queryToken ? String(req.query?.token || "").trim() : "";
  const authorization = String(req.headers?.authorization || "").trim();
  const cookie = String(req.headers?.cookie || "").trim();
  if (!token && !authorization && !cookie) return null;
  const user = await getBetterAuthUser(
    token ? getBearerHeaders(token, req.headers) : req.headers,
  );
  if (user) req.user = user;
  return user;
}

const getBearerToken = (req) => {
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
};

export function getUnauthorizedDetails(req) {
  if (getBearerToken(req)) {
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

export function sendUnauthorizedResponse(req, res, { challenge = false, ...overrides } = {}) {
  if (challenge) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Aurral"');
  }
  return res.status(401).json({
    error: "Unauthorized",
    ...getUnauthorizedDetails(req),
    ...overrides,
  });
}

export async function resolveSessionUserFromToken(token) {
  if (!token) return null;
  return getBetterAuthUser(getBearerHeaders(token));
}

export async function resolveSessionUserFromHeaders(headers) {
  return getBetterAuthUser(headers || {});
}

function resolveApiKeyUser(req) {
  const headerKey = (req.headers["x-api-key"] || "").trim();
  const queryKey = (req.query?.api_key || "").trim();
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

export function isRequestFromTrustedLocalSubnet(req) {
  const requestIps = getRequestIps(req);
  if (requestIps.some((ip) => isLoopbackIp(ip))) {
    return true;
  }
  const subnet = inferTrustedLocalSubnet();
  if (!subnet) return false;
  return requestIps.some((ip) => {
    if (!isPrivateIpv4(ip)) return false;
    const ipInt = ipv4ToInt(ip);
    if (ipInt == null) return false;
    return (ipInt & ipv4ToInt(subnet.netmask)) >>> 0 === subnet.networkInt;
  });
}

export function getLocalNetworkBypassStatus(req) {
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

export function ensureExternalUser(username, role) {
  const identity = getProxyIdentity(username);
  const existing = userOps.getUserByUsername(username);
  if (existing) {
    if (existing.role !== role) {
      const updated = userOps.updateUser(existing.id, { role });
      return {
        ...toResolvedUser(updated || existing),
        ...identity,
      };
    }
    return {
      ...toResolvedUser(existing),
      ...identity,
    };
  }
  const passwordHash = hashPassword(crypto.randomBytes(32).toString("hex"));
  const created = userOps.createUser(username, passwordHash, role, null, identity);
  const resolved = created
    ? toResolvedUser(userOps.getUserByUsername(created.username) || created)
    : toResolvedUser(userOps.getUserByUsername(username));
  return resolved ? { ...resolved, ...identity } : null;
}

function isProxyAdmin(req, username) {
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

function resolveProxyRole(req, username) {
  const defaultRole =
    (process.env.AUTH_PROXY_DEFAULT_ROLE || "user").trim().toLowerCase() === "admin"
      ? "admin"
      : "user";
  return isProxyAdmin(req, username) ? "admin" : defaultRole;
}

export function resolveProxyUser(req) {
  if (!isProxyAuthEnabled()) return null;
  if (!isTrustedProxy(req)) return null;
  const headerName = getProxyHeaderName();
  const rawUsername = getHeaderValue(req, headerName);
  const username = String(rawUsername || "").trim();
  if (!username) return null;

  const role = resolveProxyRole(req, username);
  return ensureExternalUser(username, role);
}

export async function issueProxySession(req) {
  if (!isAuthRequiredByConfig()) return null;
  if (await resolveSessionUserFromToken(getBearerToken(req))) return null;
  const proxyUser = resolveProxyUser(req);
  if (!proxyUser?.id || proxyUser.id < 0) return null;
  return createAuthSession(proxyUser.id, req);
}

function migrateLegacyAdmin() {
  if (userOps.countUsers() > 0) return;
  const settings = dbOps.getSettings();
  const onboardingComplete = settings.onboardingComplete;
  const authUser = settings.integrations?.general?.authUser || "admin";
  const authPassword = settings.integrations?.general?.authPassword;
  if (!onboardingComplete || !authPassword) return;
  const hash = hashPassword(authPassword);
  userOps.createUser(authUser, hash, "admin", null);
}

export function resolveUser(username, password) {
  if (userOps.countUsers() === 0) {
    migrateLegacyAdmin();
    if (userOps.countUsers() === 0) return null;
  }
  const un = String(username || "")
    .trim()
    .toLowerCase();
  const u = userOps.getUserByUsername(un);
  if (!u || !password) return null;
  const passwordHash = userOps.getCredentialPasswordHash(u.id) || u.passwordHash;
  if (!passwordHash || !verifyPassword(password, passwordHash)) return null;
  if (needsRehash(passwordHash)) {
    userOps.updateCredentialPasswordHash(u.id, hashPassword(password));
  }
  const perms = buildPermissions(u.role, u.permissions);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    permissions: perms,
  };
}

export function resolveSubsonicTokenUser(username, token, salt) {
  if (!/^[a-f\d]{32}$/i.test(String(token || "")) || !String(salt || "")) return null;
  if (
    !safeCompare(
      String(username || "").trim().toLowerCase(),
      String(getAuthUser()).trim().toLowerCase(),
    )
  ) return null;

  const matchedPassword = getAuthPassword().find((password) =>
    safeCompare(
      crypto.createHash("md5").update(`${password}${salt}`).digest("hex"),
      token,
    ),
  );
  return matchedPassword ? resolveUser(username, matchedPassword) : null;
}

export function resolveLocalNetworkBypassUser(req) {
  const status = getLocalNetworkBypassStatus(req);
  if (!status.active) return null;
  return toResolvedUser(getSoleAdminUser());
}

export function resolveRequestUser(req) {
  if (req.user) return req.user;
  const proxyUser = resolveProxyUser(req);
  if (proxyUser) return proxyUser;
  const apiKeyUser = resolveApiKeyUser(req);
  if (apiKeyUser) return apiKeyUser;
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

export function issueStreamToken(user, ttlMs = STREAM_TOKEN_TTL_MS) {
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

function consumeStreamToken(rawToken) {
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

const isPublicAuthPath = (req) =>
  req.path === "/api/health" ||
  req.path === "/api/health/live" ||
  req.path === "/api/health/bootstrap" ||
  req.path === "/api/filesystem/browse" ||
  req.path === "/api/filesystem/ensure" ||
  req.path === "/api/image-proxy" ||
  req.path.startsWith("/api/image-proxy/") ||
  (req.method === "GET" && /^\/api\/feeds\/lidarr\/flows\/[^/]+\.json$/i.test(req.path));

const isMediaAuthPath = (req) =>
  /^\/api\/library\/stream\/[^/]+$/.test(req.path) ||
  /^\/api\/library\/canonical-stream\/[^/]+\/[^/]+$/i.test(req.path) ||
  /^\/api\/library\/file-stream\/[^/]+\/[^/]+$/i.test(req.path) ||
  /^\/api\/artists\/[a-f0-9-]{36}\/stream$/i.test(req.path) ||
  /^\/api\/weekly-flow\/stream\/[^/]+$/i.test(req.path) ||
  /^\/api\/playlists\/stream\/[^/]+$/i.test(req.path) ||
  /^\/api\/playlists\/staging-stream\/[^/]+$/i.test(req.path) ||
  (req.method === "GET" && /^\/api\/weekly-flow\/artwork\/[^/]+$/i.test(req.path)) ||
  (req.method === "GET" && /^\/api\/playlists\/artwork\/[^/]+$/i.test(req.path)) ||
  (req.method === "GET" && /^\/api\/discover\/artwork\/[^/]+$/i.test(req.path));

export const authMiddleware = async (req, res, next) => {
  if (!req.path.startsWith("/api")) return next();

  if (isPublicAuthPath(req)) {
    await hydrateBetterAuthUser(req);
    return next();
  }

  if (isMediaAuthPath(req)) {
    await hydrateBetterAuthUser(req, { queryToken: true });
    return next();
  }

  if (req.method === "GET" && req.path === "/api/scrobbling/lastfm/link/callback") {
    return next();
  }

  const settings = dbOps.getSettings();
  const onboardingDone = settings.onboardingComplete;

  if (req.path.startsWith("/api/onboarding") && !onboardingDone) return next();
  if (!isAuthRequiredByConfig()) return next();

  const user = (await hydrateBetterAuthUser(req)) || resolveRequestUser(req);
  if (user) {
    req.user = user;
    return next();
  }

  return sendUnauthorizedResponse(req, res);
};

export const verifyTokenAuth = (req) => {
  const user = resolveRequestUser(req);
  if (user) {
    req.user = user;
    return true;
  }
  const streamTokenUser = consumeStreamToken(req.query.st);
  if (streamTokenUser) {
    req.user = streamTokenUser;
    return true;
  }
  return !isAuthRequiredByConfig();
};

export function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return !!user.permissions?.[permission];
}

export const requirePasswordStrength = (password) => {
  const raw = String(password || "");
  if (raw.length < 8) {
    return {
      valid: false,
      error: "Password must be at least 8 characters long",
    };
  }
  return { valid: true };
};
