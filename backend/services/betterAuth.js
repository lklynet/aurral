import crypto from "node:crypto";
import { betterAuth } from "better-auth";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { admin, bearer, genericOAuth, username } from "better-auth/plugins";
import { db } from "../config/db-sqlite.js";
import { getInternalUserEmail } from "../db/helpers/users.js";
import { hashPassword, verifyPassword } from "../middleware/passwordHash.js";

const DEFAULT_PERMISSIONS = {
  accessFlow: false,
  addArtist: true,
  addAlbum: true,
  changeMonitoring: false,
  deleteArtist: false,
  deleteAlbum: false,
  deleteTrack: false,
};
const OIDC_ROLE_MARKER = "__aurralOidcRole";

const parseCsv = (value) =>
  String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const getOidcRoleData = (user) => {
  const role = user.permissions?.[OIDC_ROLE_MARKER];
  if (!role) return {};
  return {
    role,
    permissions: Object.fromEntries(
      Object.entries(user.permissions).filter(([key]) => key !== OIDC_ROLE_MARKER),
    ),
  };
};

function getSecret() {
  const configured = String(process.env.BETTER_AUTH_SECRET || "").trim();
  if (configured) return configured;
  const stored = db.prepare("SELECT value FROM settings WHERE key = ?").get("_betterAuthSecret");
  if (stored?.value) return stored.value;
  const generated = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    "_betterAuthSecret",
    generated,
  );
  return generated;
}

function getConfiguredBaseURL() {
  return String(process.env.BETTER_AUTH_URL || process.env.AURRAL_PUBLIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

const betterAuthLogger = {
  log(level, message, ...args) {
    if (level === "warn" && String(message).startsWith("[better-auth] Base URL is not set.")) {
      return;
    }
    console[level](`[Better Auth] ${message}`, ...args);
  },
};

function getSessionExpirySeconds() {
  const hours = Number(process.env.SESSION_EXPIRY_HOURS);
  return Math.round((Number.isFinite(hours) && hours > 0 ? hours : 720) * 60 * 60);
}

function resolveOidcUsername(profile = {}) {
  const claim = String(process.env.OIDC_USERNAME_CLAIM || "preferred_username").trim();
  return String(profile[claim] || profile.email || profile.sub || "").trim().toLowerCase();
}

function resolveOidcRole(profile = {}, usernameValue = "") {
  const usernameLower = String(usernameValue).toLowerCase();
  if (parseCsv(process.env.OIDC_ADMIN_USERS).some((entry) => entry.toLowerCase() === usernameLower)) {
    return "admin";
  }
  const groupsClaim = String(process.env.OIDC_GROUPS_CLAIM || "").trim();
  const groups = Array.isArray(profile[groupsClaim])
    ? profile[groupsClaim]
    : String(profile[groupsClaim] || "").split(/[\s,]+/);
  const adminGroups = new Set(
    parseCsv(process.env.OIDC_ADMIN_GROUPS).map((entry) => entry.toLowerCase()),
  );
  if (groups.some((entry) => adminGroups.has(String(entry).trim().toLowerCase()))) return "admin";
  return String(process.env.OIDC_DEFAULT_ROLE || "user").toLowerCase() === "admin"
    ? "admin"
    : "user";
}

export function isOidcEnabled() {
  return (
    process.env.OIDC_ENABLED === "true" &&
    Boolean(
      String(process.env.OIDC_ISSUER || "").trim() &&
        String(process.env.OIDC_CLIENT_ID || "").trim() &&
        String(process.env.OIDC_CLIENT_SECRET || "").trim(),
    )
  );
}

export function getOidcProviderId() {
  return String(process.env.OIDC_PROVIDER_ID || "oidc").trim() || "oidc";
}

export function getOidcBootstrapInfo() {
  return {
    oidcEnabled: isOidcEnabled(),
    oidcLogoutUrl: isOidcEnabled() ? process.env.OIDC_LOGOUT_URL || null : null,
  };
}

function getOidcPlugin() {
  if (!isOidcEnabled()) return null;
  const issuer = String(process.env.OIDC_ISSUER).replace(/\/+$/, "");
  const providerId = getOidcProviderId();
  return genericOAuth({
    config: [
      {
        providerId,
        discoveryUrl:
          String(process.env.OIDC_DISCOVERY_URL || "").trim() ||
          `${issuer}/.well-known/openid-configuration`,
        clientId: String(process.env.OIDC_CLIENT_ID),
        clientSecret: String(process.env.OIDC_CLIENT_SECRET),
        redirectURI: String(process.env.OIDC_REDIRECT_URI || "").trim() || undefined,
        scopes: String(process.env.OIDC_SCOPES || "openid profile email")
          .split(/\s+/)
          .filter(Boolean),
        requireIdTokenVerification: true,
        overrideUserInfo: true,
        mapProfileToUser(profile) {
          const resolvedUsername = resolveOidcUsername(profile);
          const role = resolveOidcRole(profile, resolvedUsername);
          return {
            displayUsername: resolvedUsername,
            role,
            permissions: {
              ...(role === "admin" ? {} : DEFAULT_PERMISSIONS),
              [OIDC_ROLE_MARKER]: role,
            },
          };
        },
      },
    ],
  });
}

const oidcPlugin = getOidcPlugin();
const configuredBaseURL = getConfiguredBaseURL();
const trustedOrigins = [configuredBaseURL, ...parseCsv(process.env.CORS_ORIGIN)].filter(Boolean);
const useCrossOriginCookies = parseCsv(process.env.CORS_ORIGIN).length > 0;

export const auth = betterAuth({
  appName: "Aurral",
  baseURL: configuredBaseURL || undefined,
  basePath: "/api/auth",
  secret: getSecret(),
  logger: betterAuthLogger,
  database: db,
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    password: {
      hash: async (password) => hashPassword(password),
      verify: async ({ hash, password }) => verifyPassword(password, hash),
    },
  },
  user: {
    modelName: "users",
    fields: {
      name: "name",
      email: "email",
      emailVerified: "email_verified",
      image: "image",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    additionalFields: {
      permissions: {
        type: "json",
        fieldName: "permissions",
        required: false,
        defaultValue: DEFAULT_PERMISSIONS,
        input: true,
      },
      passwordHash: {
        type: "string",
        fieldName: "password_hash",
        required: false,
        defaultValue: "",
        returned: false,
        input: false,
      },
    },
  },
  session: {
    modelName: "sessions",
    fields: {
      userId: "user_id",
      token: "token",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    expiresIn: getSessionExpirySeconds(),
    updateAge: 24 * 60 * 60,
  },
  account: {
    modelName: "accounts",
    fields: {
      userId: "user_id",
      accountId: "account_id",
      providerId: "provider_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    modelName: "verifications",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => ({
          data: {
            ...user,
            ...getOidcRoleData(user),
            username: String(user.username || user.displayUsername || user.email || "")
              .trim()
              .toLowerCase(),
            displayUsername: String(user.displayUsername || user.name || user.email || "").trim(),
          },
        }),
      },
      update: {
        before: async (user) => ({
          data: {
            ...user,
            ...getOidcRoleData(user),
          },
        }),
      },
    },
  },
  advanced: {
    database: { generateId: "serial" },
    defaultCookieAttributes: {
      sameSite: useCrossOriginCookies ? "none" : "lax",
    },
  },
  plugins: [
    bearer(),
    username({
      minUsernameLength: 1,
      maxUsernameLength: 254,
      usernameValidator: (value) => Boolean(String(value || "").trim()),
      schema: {
        user: {
          fields: {
            username: "username",
            displayUsername: "display_username",
          },
        },
      },
    }),
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
      schema: {
        user: {
          fields: {
            role: "role",
            banned: "banned",
            banReason: "ban_reason",
            banExpires: "ban_expires",
          },
        },
        session: { fields: { impersonatedBy: "impersonated_by" } },
      },
    }),
    ...(oidcPlugin ? [oidcPlugin] : []),
  ],
  telemetry: { enabled: false },
});

export const betterAuthHandler = toNodeHandler(auth);

export async function getSessionForHeaders(headers) {
  const session = await auth.api.getSession({
    headers: headers instanceof Headers ? headers : fromNodeHeaders(headers || {}),
  });
  return session || null;
}

export async function createAuthUser({ email, name, username: usernameValue, role = "user", permissions }) {
  const normalizedUsername = String(usernameValue || email || "").trim().toLowerCase();
  const normalizedEmail = getInternalUserEmail(normalizedUsername, email);
  const normalizedName = String(name || normalizedUsername).trim();
  const result = await auth.api.createUser({
    body: {
      email: normalizedEmail,
      name: normalizedName,
      role,
      data: {
        username: normalizedUsername,
        displayUsername: normalizedName,
        permissions: permissions || DEFAULT_PERMISSIONS,
      },
    },
  });
  return result?.user || result || null;
}

export async function createAuthSession(userId, request = {}) {
  const context = await auth.$context;
  return context.internalAdapter.createSession(String(userId), false, {
    ipAddress: request.ip || null,
    userAgent: request.headers?.["user-agent"] || null,
  });
}

export async function setAuthUserPassword(userId, password) {
  const context = await auth.$context;
  const normalizedUserId = String(userId);
  const hashedPassword = await context.password.hash(String(password));
  if (await context.internalAdapter.findCredentialAccount(normalizedUserId)) {
    await context.internalAdapter.updatePassword(normalizedUserId, hashedPassword);
  } else {
    await context.internalAdapter.createAccount({
      userId: normalizedUserId,
      accountId: normalizedUserId,
      providerId: "credential",
      issuer: "local:credential",
      password: hashedPassword,
    });
  }
  await context.internalAdapter.deleteUserSessions(normalizedUserId);
}

export async function removeAuthUser(userId) {
  const context = await auth.$context;
  const normalizedUserId = String(userId);
  await context.internalAdapter.deleteUserSessions(normalizedUserId);
  await context.internalAdapter.deleteUser(normalizedUserId);
}
