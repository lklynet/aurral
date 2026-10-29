import { Hono } from "hono";
import * as v from "valibot";
import { userOps, dbOps, userIdentityOps } from "../db/helpers/index.ts";
import { hashPassword, verifyPassword } from "../middleware/passwordHash.ts";
import {
  requireAuth,
  requireAdmin,
  requireRecentAuth,
  requireUserAccount,
} from "../middleware/guards.ts";
import { validate } from "../middleware/validate.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { normalizeUserThemeDocument, ThemeValidationError } from "../services/userTheme.ts";
import {
  isRecentlyAuthenticated,
  reconcileLocalNetworkBypassSetting,
  requirePasswordStrength,
} from "../middleware/auth.ts";
import { deleteSessionsByUserId } from "../config/session-helpers.ts";
import { websocketService } from "../services/websocketService.ts";
import {
  getUserDiscoveryNamespace,
  requestUserDiscoveryRefresh,
} from "../services/discovery/index.ts";
import {
  getListenHistoryProfile,
  listenHistoryProfilesEqual,
  normalizeListenHistoryProvider,
  normalizeListenHistoryUrl,
  normalizeListenHistoryUsername,
  resolveListenHistorySettings,
} from "../services/listeningHistory.ts";
import { validateExternalUrl } from "../middleware/urlValidator.ts";
import { normalizeKoitoBaseUrl } from "../services/koitoClient.ts";
import { disconnectUserPlex, resolveGlobalPlexAccount } from "./users/plexLinkHandlers.ts";
import { plexConnectionStore } from "../services/plex/plexConnectionStore.ts";
import { asAppError, type AppError } from "../../lib/errors.ts";
import { isErrorStatus } from "./shared/errorStatus.ts";

type UserRecord = NonNullable<ReturnType<typeof userOps.getUserById>>;

type ListenHistoryBody = {
  lastfmUsername?: unknown;
  listenHistoryProvider?: unknown;
  listenHistoryUsername?: unknown;
  listenHistoryUrl?: unknown;
};

type UserUpdate = Parameters<typeof userOps.updateUser>[1];

const buildListenHistoryUpdates = (body: ListenHistoryBody, existing: UserRecord) => {
  const hasLegacyLastfmUpdate = Object.hasOwn(body, "lastfmUsername");
  const hasListenHistoryProviderUpdate = Object.hasOwn(body, "listenHistoryProvider");
  const hasListenHistoryUsernameUpdate = Object.hasOwn(body, "listenHistoryUsername");
  const hasListenHistoryUrlUpdate = Object.hasOwn(body, "listenHistoryUrl");
  if (
    !hasListenHistoryProviderUpdate &&
    !hasListenHistoryUsernameUpdate &&
    !hasListenHistoryUrlUpdate &&
    !hasLegacyLastfmUpdate
  ) {
    return null;
  }

  const provider = normalizeListenHistoryProvider(
    hasListenHistoryProviderUpdate
      ? body.listenHistoryProvider
      : hasLegacyLastfmUpdate
        ? "lastfm"
        : existing.listenHistoryProvider,
  );

  if (provider === "local") {
    return {
      listenHistoryProvider: "local",
      listenHistoryUsername: null,
      listenHistoryUrl: null,
    };
  }

  if (provider === "koito") {
    const rawUrl = hasListenHistoryUrlUpdate ? body.listenHistoryUrl : existing.listenHistoryUrl;
    const trimmedUrl = normalizeListenHistoryUrl(rawUrl);
    if (!trimmedUrl) {
      const error: AppError = new Error("Koito URL is required");
      error.statusCode = 400;
      throw error;
    }
    const urlValidation = validateExternalUrl(trimmedUrl);
    if (!urlValidation.valid) {
      const error: AppError = new Error(urlValidation.error || "Invalid Koito URL");
      error.statusCode = 400;
      throw error;
    }
    return {
      listenHistoryProvider: "koito",
      listenHistoryUrl: normalizeKoitoBaseUrl(urlValidation.url),
      listenHistoryUsername: null,
    };
  }

  const username = normalizeListenHistoryUsername(
    hasListenHistoryUsernameUpdate
      ? body.listenHistoryUsername
      : hasLegacyLastfmUpdate
        ? body.lastfmUsername
        : existing.listenHistoryUsername,
  );
  return {
    listenHistoryProvider: provider,
    listenHistoryUsername: username,
    listenHistoryUrl: null,
  };
};

const reconcileLocalBypassAfterUserMutation = () => {
  const result = reconcileLocalNetworkBypassSetting();
  if (result.changed) {
    websocketService.reconcileAuthState();
  }
  return result;
};

const normalizeRootFolderPath = (value: unknown) => {
  const normalized = String(value || "").trim();
  return normalized || null;
};

const normalizeQualityProfileId = (value: unknown) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
};

const DEFAULT_DISCOVER_LAYOUT = [
  { id: "recentlyAdded", enabled: true },
  { id: "playlists", enabled: true },
  { id: "recommendedShows", enabled: true },
  { id: "recentReleases", enabled: true },
  { id: "news", enabled: true },
  { id: "recommended", enabled: true },
  { id: "globalTop", enabled: true },
  { id: "genreSections", enabled: true },
];

const normalizeDiscoverLayout = (value: unknown) => {
  if (!Array.isArray(value)) return null;
  const defaultsById = new Map(DEFAULT_DISCOVER_LAYOUT.map((item) => [item.id, item]));
  const normalized = [];
  for (const item of value) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    if (!defaultsById.has(id)) continue;
    normalized.push({
      id,
      enabled: typeof item?.enabled === "boolean" ? item.enabled : defaultsById.get(id)!.enabled,
    });
    defaultsById.delete(id);
  }
  for (const item of defaultsById.values()) {
    normalized.push({ ...item });
  }
  return normalized;
};

const refreshDiscoveryForListenHistoryChange = (
  userId: number,
  existingProfile: ReturnType<typeof getListenHistoryProfile>,
  nextProfile: ReturnType<typeof getListenHistoryProfile>,
) => {
  if (listenHistoryProfilesEqual(existingProfile, nextProfile)) return;
  requestUserDiscoveryRefresh(userId, { reason: "listening_history" });
};

const isValidPermissions = (permissions: unknown): permissions is Record<string, boolean> =>
  typeof permissions === "object" &&
  permissions !== null &&
  !Array.isArray(permissions) &&
  Object.values(permissions).every((value) => typeof value === "boolean");

const INVALID_PERMISSIONS_ERROR = "Permissions must be true or false";
const VALID_STATUSES = ["active", "suspended", "disabled"];

const createUserBody = v.object({
  username: v.optional(v.string()),
  password: v.optional(v.string()),
  role: v.optional(v.string()),
  permissions: v.optional(v.unknown()),
});
const nullableText = v.optional(v.nullable(v.string()));
const updateUserBody = v.object({
  password: v.optional(v.string()),
  currentPassword: v.optional(v.string()),
  permissions: v.optional(v.unknown()),
  role: v.optional(v.string()),
  status: v.optional(v.string()),
  allowIdentityAdoption: v.optional(v.boolean()),
  listenHistoryProvider: nullableText,
  listenHistoryUsername: nullableText,
  listenHistoryUrl: nullableText,
  lastfmUsername: nullableText,
});
const themeBody = v.object({ theme: v.optional(v.unknown()) });
const discoverLayoutBody = v.object({ layout: v.optional(v.unknown()) });
const lidarrPreferencesBody = v.object({
  rootFolderPath: nullableText,
  qualityProfileId: v.optional(v.nullable(v.union([v.number(), v.string()]))),
});
const passwordBody = v.object({
  currentPassword: v.optional(v.string()),
  newPassword: v.optional(v.string()),
});

export default new Hono<AppEnv>()
  .basePath("/users")
  .get("/", requireAuth, requireAdmin, async (c) => {
    try {
      const users = userOps.getAllUsers();
      const globalPlexAccount = await resolveGlobalPlexAccount();
      return c.json(
        users.map((user) => ({
          ...user,
          plexLink: plexConnectionStore.getPublicStatus(user.id),
          plexGlobalAccount: globalPlexAccount,
        })),
        200,
      );
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to list users", message: failure?.message }, 500);
    }
  })
  .post("/", requireAuth, requireAdmin, validate("json", createUserBody), (c) => {
    try {
      const { username, password, role = "user", permissions } = c.req.valid("json");
      const un = (username || "").trim();
      if (!un || !password) {
        return c.json({ error: "Username and password required" }, 400);
      }
      if (permissions && !isValidPermissions(permissions)) {
        return c.json({ error: INVALID_PERMISSIONS_ERROR }, 400);
      }
      if (userOps.getUserByUsername(un)) {
        return c.json({ error: "Username already exists" }, 409);
      }
      const passwordValidation = requirePasswordStrength(password);
      if (!passwordValidation.valid) {
        return c.json({ error: passwordValidation.error }, 400);
      }
      const hash = hashPassword(password);
      const perms = isValidPermissions(permissions)
        ? { ...userOps.getDefaultPermissions(), ...permissions }
        : null;
      const created = userOps.createUser(un, hash, role, perms, true, false, password);
      if (!created) {
        return c.json({ error: "Failed to create user" }, 500);
      }
      reconcileLocalBypassAfterUserMutation();
      return c.json(
        {
          id: created.id,
          username: created.username,
          role: created.role,
          permissions: created.permissions,
          lidarrRootFolderPath: created.lidarrRootFolderPath,
          lidarrQualityProfileId: created.lidarrQualityProfileId,
        },
        201,
      );
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to create user", message: failure?.message }, 500);
    }
  })
  .patch("/:id", requireAuth, validate("json", updateUserBody), (c) => {
    try {
      const id = parseInt(c.req.param("id"), 10);
      const isAdmin = c.var.user.role === "admin";
      const isSelf = c.var.user.id === id;
      if (!isAdmin && !isSelf) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const existing = userOps.getUserById(id);
      if (!existing) {
        return c.json({ error: "User not found" }, 404);
      }
      const body = c.req.valid("json");
      const { password, permissions, role, status, allowIdentityAdoption } = body;
      if (status !== undefined && !VALID_STATUSES.includes(status)) {
        return c.json({ error: "Invalid status" }, 400);
      }
      if (permissions != null && !isValidPermissions(permissions)) {
        return c.json({ error: INVALID_PERMISSIONS_ERROR }, 400);
      }
      const existingProfile = getListenHistoryProfile(existing);
      let listenHistoryUpdates = null;
      try {
        listenHistoryUpdates = buildListenHistoryUpdates(body, existing);
      } catch (error) {
        const failure = asAppError(error);
        return c.json(
          { error: failure?.message || "Invalid listening history settings" },
          isErrorStatus(failure?.statusCode) ? failure.statusCode : 400,
        );
      }
      const requestedProfile = getListenHistoryProfile({
        ...existing,
        ...(listenHistoryUpdates || {}),
      });
      refreshDiscoveryForListenHistoryChange(id, existingProfile, requestedProfile);
      if (isSelf && !isAdmin) {
        if (
          permissions !== undefined ||
          role !== undefined ||
          status !== undefined ||
          allowIdentityAdoption !== undefined
        ) {
          return c.json({ error: "Forbidden" }, 403);
        }
        const updates: UserUpdate = {};
        if (listenHistoryUpdates) {
          Object.assign(updates, listenHistoryUpdates);
        }
        if (password) {
          const { currentPassword } = body;
          if (!currentPassword) {
            return c.json({ error: "currentPassword required to change password" }, 400);
          }
          if (!verifyPassword(currentPassword, existing.passwordHash)) {
            return c.json({ error: "Current password is incorrect" }, 400);
          }
          const passwordValidation = requirePasswordStrength(password);
          if (!passwordValidation.valid) {
            return c.json({ error: passwordValidation.error }, 400);
          }
          updates.passwordHash = hashPassword(password);
          updates.hasLocalPassword = true;
          updates.subsonicPassword = password;
        }
        if (Object.keys(updates).length === 0) {
          return c.json(
            {
              id,
              username: existing.username,
              role: existing.role,
              listenHistoryProvider: existing.listenHistoryProvider,
              listenHistoryUsername: existing.listenHistoryUsername,
              listenHistoryUrl: existing.listenHistoryUrl,
              lastfmUsername: existing.lastfmUsername,
              lidarrRootFolderPath: existing.lidarrRootFolderPath,
              lidarrQualityProfileId: existing.lidarrQualityProfileId,
            },
            200,
          );
        }
        const updated = userOps.updateUser(id, updates);
        if (updates.passwordHash) {
          deleteSessionsByUserId(id);
        }
        return c.json(updated, 200);
      }
      const updates: UserUpdate = {};
      if (password) {
        if (!isSelf && !isRecentlyAuthenticated(c.req.header("authorization"))) {
          return c.json(
            { error: "reauth_required", message: "Please confirm your credentials to continue" },
            401,
          );
        }
        const passwordValidation = requirePasswordStrength(password);
        if (!passwordValidation.valid) {
          return c.json({ error: passwordValidation.error }, 400);
        }
        updates.passwordHash = hashPassword(password);
        updates.hasLocalPassword = true;
        updates.subsonicPassword = password;
      }
      if (permissions !== undefined) {
        updates.permissions = isValidPermissions(permissions) ? permissions : {};
      }
      if (role !== undefined) {
        updates.role = role;
        updates.roleSource = "local";
      }
      if (status !== undefined) {
        if (existing.isProtected && status !== "active") {
          return c.json(
            { error: "You cannot suspend or disable a protected recovery account" },
            400,
          );
        }
        updates.status = status;
      }
      if (allowIdentityAdoption !== undefined) {
        if (allowIdentityAdoption && !existing.needsIdentityMigration) {
          return c.json(
            { error: "Only accounts that predate identity linking can be approved for adoption" },
            400,
          );
        }
        if (allowIdentityAdoption && existing.isProtected) {
          return c.json(
            { error: "The protected recovery account cannot be approved for adoption" },
            400,
          );
        }
        updates.allowIdentityAdoption = allowIdentityAdoption;
      }
      if (listenHistoryUpdates) {
        Object.assign(updates, listenHistoryUpdates);
      }
      if (Object.keys(updates).length === 0) {
        return c.json(
          {
            id: existing.id,
            username: existing.username,
            role: existing.role,
            permissions: existing.permissions,
            listenHistoryProvider: existing.listenHistoryProvider,
            listenHistoryUsername: existing.listenHistoryUsername,
            listenHistoryUrl: existing.listenHistoryUrl,
            lastfmUsername: existing.lastfmUsername,
            lidarrRootFolderPath: existing.lidarrRootFolderPath,
            lidarrQualityProfileId: existing.lidarrQualityProfileId,
          },
          200,
        );
      }
      const updated = userOps.updateUser(id, updates);
      if (updates.status && updates.status !== "active") {
        deleteSessionsByUserId(id);
        websocketService.disconnectUser(id);
      }
      reconcileLocalBypassAfterUserMutation();
      return c.json(updated, 200);
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to update user", message: failure?.message }, 500);
    }
  })
  .get("/me/listening-history", requireAuth, (c) => {
    try {
      const user = userOps.getUserById(c.var.user.id);
      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }
      return c.json(resolveListenHistorySettings(user), 200);
    } catch (e) {
      const failure = asAppError(e);
      return c.json(
        { error: "Failed to get listening history settings", message: failure?.message },
        500,
      );
    }
  })
  .get("/me/lidarr-preferences", requireAuth, async (c) => {
    try {
      const user = userOps.getUserById(c.var.user.id);
      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }
      const { lidarrClient } = await import("../services/lidarrClient.ts");
      return c.json(await lidarrClient.getArtistAddPreferenceSummary(user), 200);
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to get Lidarr preferences", message: failure?.message }, 500);
    }
  })
  .get("/me/theme", requireAuth, requireUserAccount, (c) => {
    try {
      const stored = dbOps.getUserTheme(c.var.user.id);
      let theme = null;
      try {
        theme = stored ? normalizeUserThemeDocument(stored) : null;
      } catch {
        theme = null;
      }
      return c.json({ theme }, 200);
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to get theme", message: failure?.message }, 500);
    }
  })
  .put("/me/theme", requireAuth, requireUserAccount, validate("json", themeBody), (c) => {
    try {
      const theme = normalizeUserThemeDocument(c.req.valid("json").theme);
      dbOps.setUserTheme(c.var.user.id, theme);
      return c.json({ theme }, 200);
    } catch (e) {
      const failure = asAppError(e);
      if (e instanceof ThemeValidationError) {
        return c.json({ error: "Invalid theme", message: failure?.message, field: "theme" }, 400);
      }
      return c.json({ error: "Failed to save theme", message: failure?.message }, 500);
    }
  })
  .get("/me/discover-layout", requireAuth, (c) => {
    try {
      const user = userOps.getUserById(c.var.user.id);
      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }
      const storedLayout = dbOps.getUserDiscoverLayout(c.var.user.id);
      return c.json({ layout: normalizeDiscoverLayout(storedLayout) }, 200);
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to get discover layout", message: failure?.message }, 500);
    }
  })
  .patch("/me/discover-layout", requireAuth, validate("json", discoverLayoutBody), (c) => {
    try {
      const user = userOps.getUserById(c.var.user.id);
      if (!user) {
        return c.json({ error: "User not found" }, 404);
      }
      const normalized = normalizeDiscoverLayout(c.req.valid("json").layout);
      if (!normalized) {
        return c.json(
          {
            error: "Invalid discover layout",
            message: "layout must be an array of discover section entries",
            field: "layout",
          },
          400,
        );
      }
      dbOps.setUserDiscoverLayout(c.var.user.id, normalized);
      return c.json(
        { layout: normalizeDiscoverLayout(dbOps.getUserDiscoverLayout(c.var.user.id)) },
        200,
      );
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to save discover layout", message: failure?.message }, 500);
    }
  })
  .patch(
    "/me/lidarr-preferences",
    requireAuth,
    validate("json", lidarrPreferencesBody),
    async (c) => {
      try {
        const user = userOps.getUserById(c.var.user.id);
        if (!user) {
          return c.json({ error: "User not found" }, 404);
        }

        const body = c.req.valid("json");
        const hasRootFolderPath = body.rootFolderPath !== undefined;
        const hasQualityProfileId = body.qualityProfileId !== undefined;

        const nextRootFolderPath = hasRootFolderPath
          ? body.rootFolderPath === null
            ? null
            : normalizeRootFolderPath(body.rootFolderPath)
          : user.lidarrRootFolderPath;
        const nextQualityProfileId = hasQualityProfileId
          ? body.qualityProfileId === null
            ? null
            : normalizeQualityProfileId(body.qualityProfileId)
          : user.lidarrQualityProfileId;

        if (hasRootFolderPath && body.rootFolderPath !== null && !nextRootFolderPath) {
          return c.json(
            {
              error: "Invalid Lidarr preferences",
              message: "rootFolderPath must be a non-empty string or null",
              field: "rootFolderPath",
            },
            400,
          );
        }

        if (
          hasQualityProfileId &&
          body.qualityProfileId !== null &&
          nextQualityProfileId === null
        ) {
          return c.json(
            {
              error: "Invalid Lidarr preferences",
              message: "qualityProfileId must be a numeric id or null",
              field: "qualityProfileId",
            },
            400,
          );
        }

        const { lidarrClient } = await import("../services/lidarrClient.ts");
        if (!lidarrClient.isConfigured()) {
          if (nextRootFolderPath !== null || nextQualityProfileId !== null) {
            return c.json(
              {
                error: "Lidarr is not configured",
                message: "Configure Lidarr before saving library defaults.",
              },
              503,
            );
          }
          const updated = userOps.updateUser(c.var.user.id, {
            lidarrRootFolderPath: null,
            lidarrQualityProfileId: null,
          });
          return c.json(
            {
              configured: false as const,
              rootFolders: [],
              qualityProfiles: [],
              savedDefaults: {
                rootFolderPath: updated?.lidarrRootFolderPath || null,
                qualityProfileId: updated?.lidarrQualityProfileId ?? null,
              },
              fallbacks: {
                rootFolderPath: null,
                qualityProfileId: null,
              },
            },
            200,
          );
        }

        const summary = await lidarrClient.getArtistAddPreferenceSummary(user);
        if (
          nextRootFolderPath !== null &&
          !summary.rootFolders.some((folder) => folder.path === nextRootFolderPath)
        ) {
          return c.json(
            {
              error: "Invalid Lidarr preferences",
              message: `Unknown Lidarr root folder: ${nextRootFolderPath}`,
              field: "rootFolderPath",
            },
            400,
          );
        }
        if (
          nextQualityProfileId !== null &&
          !summary.qualityProfiles.some((profile) => profile.id === nextQualityProfileId)
        ) {
          return c.json(
            {
              error: "Invalid Lidarr preferences",
              message: `Unknown Lidarr quality profile: ${nextQualityProfileId}`,
              field: "qualityProfileId",
            },
            400,
          );
        }

        const updated = userOps.updateUser(c.var.user.id, {
          lidarrRootFolderPath: nextRootFolderPath,
          lidarrQualityProfileId: nextQualityProfileId,
        });
        if (!updated) {
          return c.json({ error: "Failed to save Lidarr preferences" }, 500);
        }

        return c.json(await lidarrClient.getArtistAddPreferenceSummary(updated), 200);
      } catch (e) {
        const failure = asAppError(e);
        return c.json(
          { error: "Failed to save Lidarr preferences", message: failure?.message },
          500,
        );
      }
    },
  )
  .post("/me/password", requireAuth, requireRecentAuth(), validate("json", passwordBody), (c) => {
    try {
      const { currentPassword, newPassword } = c.req.valid("json");
      if (!newPassword) {
        return c.json({ error: "New password required" }, 400);
      }
      const passwordValidation = requirePasswordStrength(newPassword);
      if (!passwordValidation.valid) {
        return c.json({ error: passwordValidation.error }, 400);
      }
      const u = userOps.getUserById(c.var.user.id);
      if (!u) {
        return c.json({ error: "Current password is incorrect" }, 400);
      }
      if (u.hasLocalPassword && !verifyPassword(currentPassword || "", u.passwordHash)) {
        return c.json({ error: "Current password is incorrect" }, 400);
      }
      userOps.updateUser(c.var.user.id, {
        passwordHash: hashPassword(newPassword),
        hasLocalPassword: true,
        subsonicPassword: newPassword,
      });
      deleteSessionsByUserId(c.var.user.id);
      return c.json({ success: true }, 200);
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to change password", message: failure?.message }, 500);
    }
  })
  .delete("/:id", requireAuth, requireAdmin, (c) => {
    try {
      const id = parseInt(c.req.param("id"), 10);
      if (c.var.user.id === id) {
        return c.json({ error: "Cannot delete your own account" }, 400);
      }
      const existing = userOps.getUserById(id);
      if (!existing) {
        return c.json({ error: "User not found" }, 404);
      }
      deleteSessionsByUserId(id);
      userOps.deleteUser(id);
      dbOps.deleteUserSettings(id);
      dbOps.deleteDiscoveryCacheByPrefix(`${getUserDiscoveryNamespace(id)}:`);
      reconcileLocalBypassAfterUserMutation();
      return c.json({ success: true }, 200);
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to delete user", message: failure?.message }, 500);
    }
  })
  .get("/me/identities", requireAuth, (c) => {
    const user = userOps.getUserById(c.var.user.id);
    if (!user) {
      return c.json({ error: "User not found" }, 404);
    }
    return c.json(
      {
        hasLocalPassword: user.hasLocalPassword,
        identities: userIdentityOps.getForUser(c.var.user.id).map((identity) => ({
          id: identity.id,
          providerType: identity.providerType,
          providerKey: identity.providerKey,
          displayName: identity.displayName,
          linkedAt: identity.linkedAt,
        })),
      },
      200,
    );
  })
  .delete("/me/identities/:id", requireAuth, requireRecentAuth(), async (c) => {
    const identityId = parseInt(c.req.param("id"), 10);
    const identity = userIdentityOps.getById(identityId);
    if (!identity || identity.userId !== c.var.user.id) {
      return c.json({ error: "Identity not found" }, 404);
    }

    const user = userOps.getUserById(c.var.user.id);
    const remaining = userIdentityOps.countForUser(c.var.user.id) - 1;
    if (remaining <= 0 && !user?.hasLocalPassword) {
      return c.json(
        {
          error: "last_auth_method",
          message:
            "This is your only way to sign in. Set a local password or link another account before removing it.",
        },
        400,
      );
    }

    if (identity.providerType === "plex") {
      const result = await disconnectUserPlex(c.var.user.id, {
        context: "from connected accounts",
      });
      if (!result.disconnected) {
        return c.json({ error: result.error, message: result.message }, 400);
      }
    } else {
      userIdentityOps.unlink(identityId);
    }
    return c.json({ success: true }, 200);
  });
