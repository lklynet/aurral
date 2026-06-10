import basicAuth from "express-basic-auth";
import bcrypt from "bcrypt";
import crypto from "crypto";
import os from "os";
import { dbOps, userOps } from "../config/db-helpers.js";
import { getSessionByToken } from "../config/session-helpers.js";

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
  return (
    settings.integrations?.general?.authUser || process.env.AUTH_USER || "admin"
  );
};

export const getAuthPassword = () => {
  const settings = dbOps.getSettings();
  const dbPass = settings.integrations?.general?.authPassword;
  if (dbPass) return [dbPass];
  return process.env.AUTH_PASSWORD
    ? process.env.AUTH_PASSWORD.split(",").map((p) => p.trim())
    : [];
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
  const withoutBrackets =
    raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return withoutBrackets.startsWith("::ffff:")
    ? withoutBrackets.slice(7)
    : withoutBrackets;
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
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0)
  ) >>> 0;
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
      const subnet = buildIpv4Subnet(
        normalizedAddress,
        detail.netmask,
        name,
      );
      if (subnet) {
        candidates.push(subnet);
      }
    }
  }
  candidates.sort((a, b) =>
    `${a.interfaceName}:${a.address}`.localeCompare(
      `${b.interfaceName}:${b.address}`,
    ),
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
  const allowed = parseCsv(process.env.AUTH_PROXY_TRUSTED_IPS).map((ip) =>
    normalizeIp(ip),
  );
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
    };
  }
  return {
    ...userOps.getDefaultPermissions(),
    ...(permissions || {}),
    accessSettings: false,
  };
}

function toResolvedUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: buildPermissions(user.role, user.permissions),
  };
}

const toSessionUser = (session) => {
  if (!session?.user) return null;
  const baseUser = session.user;
  return {
    id: baseUser.id,
    username: baseUser.username,
    role: baseUser.role,
    permissions: buildPermissions(baseUser.role, baseUser.permissions),
  };
};

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

export function sendUnauthorizedResponse(
  req,
  res,
  { challenge = false, ...overrides } = {},
) {
  if (challenge) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Aurral"');
  }
  return res.status(401).json({
    error: "Unauthorized",
    ...getUnauthorizedDetails(req),
    ...overrides,
  });
}

export const resolveSessionUserFromToken = (token) => {
  if (!token) return null;
  return toSessionUser(getSessionByToken(token));
};

export const isAuthRequiredByConfig = () => {
  const settings = dbOps.getSettings();
  const onboardingDone = settings.onboardingComplete;
  if (!onboardingDone) return false;
  const users = userOps.getAllUsers();
  const legacyPasswords = getAuthPassword();
  return isProxyAuthEnabled() || users.length > 0 || legacyPasswords.length > 0;
};

export const getLocalNetworkBypassConfig = (settings = dbOps.getSettings()) =>
  normalizeLocalNetworkBypassSettings(settings);

export function getSoleAdminUser() {
  const users = userOps.getAllUsers();
  if (users.length !== 1) return null;
  const [user] = users;
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
  const users = userOps.getAllUsers();
  const soleUser = users.length === 1 ? users[0] : null;
  const soleAdminUser = getSoleAdminUser();
  const subnet = inferTrustedLocalSubnet();

  let eligible = true;
  let reason = null;

  if (!onboardingDone) {
    eligible = false;
    reason = "not_onboarded";
  } else if (users.length !== 1) {
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
    config.enabled &&
    eligible &&
    isRequestFromTrustedLocalSubnet(req) &&
    !!soleAdminUser;

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

export function resolveProxyUser(req) {
  if (!isProxyAuthEnabled()) return null;
  if (!isTrustedProxy(req)) return null;
  const headerName = getProxyHeaderName();
  const rawUsername = getHeaderValue(req, headerName);
  const username = String(rawUsername || "").trim();
  if (!username) return null;
  const existing = userOps.getUserByUsername(username);
  if (existing) {
    return toResolvedUser(existing);
  }
  const adminUsers = parseCsv(process.env.AUTH_PROXY_ADMIN_USERS).map((u) =>
    u.toLowerCase(),
  );
  const headerRoleName = process.env.AUTH_PROXY_ROLE_HEADER
    ? String(process.env.AUTH_PROXY_ROLE_HEADER).trim().toLowerCase()
    : "";
  const headerRole = headerRoleName
    ? String(getHeaderValue(req, headerRoleName) || "")
        .trim()
        .toLowerCase()
    : "";
  const defaultRole =
    (process.env.AUTH_PROXY_DEFAULT_ROLE || "user").trim().toLowerCase() ===
    "admin"
      ? "admin"
      : "user";
  const role =
    headerRole === "admin" || adminUsers.includes(username.toLowerCase())
      ? "admin"
      : defaultRole;
  return {
    id: -1,
    username,
    role,
    permissions: buildPermissions(role),
  };
}

function migrateLegacyAdmin() {
  const users = userOps.getAllUsers();
  if (users.length > 0) return;
  const settings = dbOps.getSettings();
  const onboardingComplete = settings.onboardingComplete;
  const authUser = settings.integrations?.general?.authUser || "admin";
  const authPassword = settings.integrations?.general?.authPassword;
  if (!onboardingComplete || !authPassword) return;
  const hash = bcrypt.hashSync(authPassword, 10);
  userOps.createUser(authUser, hash, "admin", null);
}

function resolveUser(username, password) {
  const users = userOps.getAllUsers();
  if (users.length === 0) {
    migrateLegacyAdmin();
  }
  const all = userOps.getAllUsers();
  if (all.length === 0) return null;
  const un = String(username || "")
    .trim()
    .toLowerCase();
  const u = userOps.getUserByUsername(un);
  if (!u || !password) return null;
  const ok = bcrypt.compareSync(password, u.passwordHash);
  if (!ok) return null;
  const perms = buildPermissions(u.role, u.permissions);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    permissions: perms,
  };
}

function legacyAuth(username, password) {
  const authUser = getAuthUser();
  const passwords = getAuthPassword();
  if (passwords.length === 0) return null;
  const userMatches = basicAuth.safeCompare(username, authUser);
  const passwordMatches = passwords.some((p) =>
    basicAuth.safeCompare(password, p),
  );
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
    },
  };
}

export function resolveLocalNetworkBypassUser(req) {
  const status = getLocalNetworkBypassStatus(req);
  if (!status.active) return null;
  return toResolvedUser(getSoleAdminUser());
}

export function resolveRequestUser(req) {
  const sessionUser = resolveSessionUserFromToken(getBearerToken(req));
  if (sessionUser) return sessionUser;
  const proxyUser = resolveProxyUser(req);
  if (proxyUser) return proxyUser;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const token = authHeader.substring(6);
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const username = colon >= 0 ? decoded.slice(0, colon) : decoded;
      const password = colon >= 0 ? decoded.slice(colon + 1) : "";
      let user = resolveUser(username, password);
      if (!user) user = legacyAuth(username, password);
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
    expiresAt:
      Date.now() + Math.max(1000, Number(ttlMs) || STREAM_TOKEN_TTL_MS),
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

export const createAuthMiddleware = () => {
  return (req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    if (
      req.path === "/api/health" ||
      req.path === "/api/health/live" ||
      req.path === "/api/health/bootstrap" ||
      req.path === "/api/image-proxy" ||
      req.path.startsWith("/api/image-proxy/")
    ) {
      return next();
    }
    if (
      /^\/api\/library\/stream\/[^/]+$/.test(req.path) ||
      /^\/api\/library\/file-stream\/[^/]+\/[^/]+$/i.test(req.path) ||
      /^\/api\/artists\/[a-f0-9-]{36}\/stream$/i.test(req.path) ||
      /^\/api\/weekly-flow\/stream\/[^/]+$/i.test(req.path) ||
      (req.method === "GET" &&
        /^\/api\/weekly-flow\/artwork\/[^/]+$/i.test(req.path))
    ) {
      return next();
    }
    if (req.path === "/api/auth/login") return next();

    const settings = dbOps.getSettings();
    const onboardingDone = settings.onboardingComplete;

    if (req.path.startsWith("/api/onboarding") && !onboardingDone)
      return next();

    const authRequired = isAuthRequiredByConfig();

    if (!authRequired) return next();

    const user = resolveRequestUser(req);
    if (user) {
      req.user = user;
      return next();
    }

    return sendUnauthorizedResponse(req, res);
  };
};

function getCredentialsFromRequest(req) {
  const sessionUser = resolveSessionUserFromToken(req.query.token);
  if (sessionUser) {
    return { type: "session", user: sessionUser };
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const token = authHeader.substring(6);
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const username = colon >= 0 ? decoded.slice(0, colon) : decoded;
      const password = colon >= 0 ? decoded.slice(colon + 1) : "";
      return { type: "basic", username, password };
    } catch (e) {
      return null;
    }
  }
  return null;
}

export const verifyTokenAuth = (req) => {
  const user = resolveRequestUser(req);
  if (user) {
    req.user = user;
    return true;
  }
  const creds = getCredentialsFromRequest(req);
  if (creds) {
    if (creds.type === "session" && creds.user) {
      req.user = creds.user;
      return true;
    }
    if (creds.type === "basic") {
      let u = resolveUser(creds.username, creds.password);
      if (!u) u = legacyAuth(creds.username, creds.password);
      if (u) {
        req.user = u;
        return true;
      }
    }
  }
  const streamTokenUser = consumeStreamToken(req.query.st);
  if (streamTokenUser) {
    req.user = streamTokenUser;
    return true;
  }
  if (isProxyAuthEnabled()) return false;
  const passwords = getAuthPassword();
  if (passwords.length === 0) return true;
  return false;
};

export function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return !!user.permissions?.[permission];
}
