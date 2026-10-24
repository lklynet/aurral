import express, { type Request, type Response } from "express";
import { userOps, dbOps } from "../db/helpers/index.ts";
import { hashPassword, verifyPassword } from "../middleware/passwordHash.ts";
import {
  requireAuth,
  requireAdmin,
  requireRecentAuth,
  requireUserAccount,
} from "../middleware/requirePermission.ts";
import { normalizeUserThemeDocument, ThemeValidationError } from "../services/userTheme.ts";
import { isRecentlyAuthenticated, reconcileLocalNetworkBypassSetting } from "../middleware/auth.ts";
import { requirePasswordStrength } from "../middleware/auth.ts";
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
import { registerPlexLink, resolveGlobalPlexAccount } from "./users/plexLinkHandlers.ts";
import { registerIdentityLink } from "./users/identityLinkHandlers.ts";
import { plexConnectionStore } from "../services/plex/plexConnectionStore.ts";
import type { lidarrClient } from "../services/lidarrClient.ts";
import { asAppError, type AppError } from "../../lib/errors.ts";

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

const router = express.Router();

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

router.get("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = userOps.getAllUsers();
    const globalPlexAccount = await resolveGlobalPlexAccount();
    res.json(
      users.map((user) => ({
        ...user,
        plexLink: plexConnectionStore.getPublicStatus(user.id),
        plexGlobalAccount: globalPlexAccount,
      })),
    );
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({ error: "Failed to list users", message: failure?.message });
  }
});

const isValidPermissions = (permissions: unknown) =>
  typeof permissions === "object" &&
  permissions !== null &&
  !Array.isArray(permissions) &&
  Object.values(permissions).every((value) => typeof value === "boolean");

const INVALID_PERMISSIONS_ERROR = "Permissions must be true or false";

router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password, role = "user", permissions } = req.body;
    const un = String(username || "").trim();
    if (!un || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    if (permissions && !isValidPermissions(permissions)) {
      return res.status(400).json({ error: INVALID_PERMISSIONS_ERROR });
    }
    if (userOps.getUserByUsername(un)) {
      return res.status(409).json({ error: "Username already exists" });
    }
    const passwordValidation = requirePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }
    const hash = hashPassword(password);
    const perms = permissions ? { ...userOps.getDefaultPermissions(), ...permissions } : null;
    const created = userOps.createUser(un, hash, role, perms, true, false, password);
    if (!created) {
      return res.status(500).json({ error: "Failed to create user" });
    }
    reconcileLocalBypassAfterUserMutation();
    res.status(201).json({
      id: created.id,
      username: created.username,
      role: created.role,
      permissions: created.permissions,
      lidarrRootFolderPath: created.lidarrRootFolderPath,
      lidarrQualityProfileId: created.lidarrQualityProfileId,
    });
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({ error: "Failed to create user", message: failure?.message });
  }
});

router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const isAdmin = req.user!.role === "admin";
    const isSelf = req.user!.id === id;
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const existing = userOps.getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }
    const { password, permissions, role, status, allowIdentityAdoption } = req.body;
    const VALID_STATUSES = ["active", "suspended", "disabled"];
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    if (permissions != null && !isValidPermissions(permissions)) {
      return res.status(400).json({ error: INVALID_PERMISSIONS_ERROR });
    }
    const existingProfile = getListenHistoryProfile(existing);
    let listenHistoryUpdates = null;
    try {
      listenHistoryUpdates = buildListenHistoryUpdates(req.body, existing);
    } catch (error) {
      const failure = asAppError(error);
      return res.status(failure?.statusCode || 400).json({
        error: failure?.message || "Invalid listening history settings",
      });
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
        return res.status(403).json({ error: "Forbidden" });
      }
      const updates: UserUpdate = {};
      if (listenHistoryUpdates) {
        Object.assign(updates, listenHistoryUpdates);
      }
      if (password) {
        const { currentPassword } = req.body;
        if (!currentPassword) {
          return res.status(400).json({ error: "currentPassword required to change password" });
        }
        if (!verifyPassword(currentPassword, existing.passwordHash)) {
          return res.status(400).json({ error: "Current password is incorrect" });
        }
        const passwordValidation = requirePasswordStrength(password);
        if (!passwordValidation.valid) {
          return res.status(400).json({ error: passwordValidation.error });
        }
        updates.passwordHash = hashPassword(password);
        updates.hasLocalPassword = true;
        updates.subsonicPassword = password;
      }
      if (Object.keys(updates).length === 0) {
        return res.json({
          id,
          username: existing.username,
          role: existing.role,
          listenHistoryProvider: existing.listenHistoryProvider,
          listenHistoryUsername: existing.listenHistoryUsername,
          listenHistoryUrl: existing.listenHistoryUrl,
          lastfmUsername: existing.lastfmUsername,
          lidarrRootFolderPath: existing.lidarrRootFolderPath,
          lidarrQualityProfileId: existing.lidarrQualityProfileId,
        });
      }
      const updated = userOps.updateUser(id, updates);
      if (updates.passwordHash) {
        deleteSessionsByUserId(id);
      }
      return res.json(updated);
    }
    const updates: UserUpdate = {};
    if (password) {
      if (!isSelf && !isRecentlyAuthenticated(req.headers.authorization)) {
        return res.status(401).json({
          error: "reauth_required",
          message: "Please confirm your credentials to continue",
        });
      }
      const passwordValidation = requirePasswordStrength(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
      updates.passwordHash = hashPassword(password);
      updates.hasLocalPassword = true;
      updates.subsonicPassword = password;
    }
    if (permissions !== undefined) updates.permissions = permissions;
    if (role !== undefined) {
      updates.role = role;
      updates.roleSource = "local";
    }
    if (status !== undefined) {
      if (existing.isProtected && status !== "active") {
        return res.status(400).json({
          error: "You cannot suspend or disable a protected recovery account",
        });
      }
      updates.status = status;
    }
    if (allowIdentityAdoption !== undefined) {
      if (allowIdentityAdoption && !existing.needsIdentityMigration) {
        return res.status(400).json({
          error: "Only accounts that predate identity linking can be approved for adoption",
        });
      }
      if (allowIdentityAdoption && existing.isProtected) {
        return res.status(400).json({
          error: "The protected recovery account cannot be approved for adoption",
        });
      }
      updates.allowIdentityAdoption = !!allowIdentityAdoption;
    }
    if (listenHistoryUpdates) {
      Object.assign(updates, listenHistoryUpdates);
    }
    if (Object.keys(updates).length === 0) {
      return res.json({
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
      });
    }
    const updated = userOps.updateUser(id, updates);
    if (updates.status && updates.status !== "active") {
      deleteSessionsByUserId(id);
      websocketService.disconnectUser(id);
    }
    reconcileLocalBypassAfterUserMutation();
    res.json(updated);
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({ error: "Failed to update user", message: failure?.message });
  }
});

const sendListenHistorySettings = (req: Request, res: Response) => {
  try {
    const user = userOps.getUserById(req.user!.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(resolveListenHistorySettings(user));
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({
      error: "Failed to get listening history settings",
      message: failure?.message,
    });
  }
};

router.get("/me/listening-history", requireAuth, sendListenHistorySettings);

router.get("/me/lidarr-preferences", requireAuth, async (req, res) => {
  try {
    const user = userOps.getUserById(req.user!.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const { lidarrClient } = await import("../services/lidarrClient.ts");
    const summary = await lidarrClient.getArtistAddPreferenceSummary(user);
    res.json(summary);
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({
      error: "Failed to get Lidarr preferences",
      message: failure?.message,
    });
  }
});

router.get("/me/theme", requireAuth, requireUserAccount, (req, res) => {
  try {
    const stored = dbOps.getUserTheme(req.user!.id);
    let theme = null;
    try {
      theme = stored ? normalizeUserThemeDocument(stored) : null;
    } catch {
      theme = null;
    }
    res.json({ theme });
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({ error: "Failed to get theme", message: failure?.message });
  }
});

router.put("/me/theme", requireAuth, requireUserAccount, (req, res) => {
  try {
    const theme = normalizeUserThemeDocument(req.body?.theme);
    dbOps.setUserTheme(req.user!.id, theme);
    res.json({ theme });
  } catch (e) {
    const failure = asAppError(e);
    if (e instanceof ThemeValidationError) {
      return res
        .status(400)
        .json({ error: "Invalid theme", message: failure?.message, field: "theme" });
    }
    res.status(500).json({ error: "Failed to save theme", message: failure?.message });
  }
});

router.get("/me/discover-layout", requireAuth, (req, res) => {
  try {
    const user = userOps.getUserById(req.user!.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const storedLayout = dbOps.getUserDiscoverLayout(req.user!.id);
    res.json({
      layout: normalizeDiscoverLayout(storedLayout),
    });
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({
      error: "Failed to get discover layout",
      message: failure?.message,
    });
  }
});

router.patch("/me/discover-layout", requireAuth, (req, res) => {
  try {
    const user = userOps.getUserById(req.user!.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const normalized = normalizeDiscoverLayout(req.body?.layout);
    if (!normalized) {
      return res.status(400).json({
        error: "Invalid discover layout",
        message: "layout must be an array of discover section entries",
        field: "layout",
      });
    }
    dbOps.setUserDiscoverLayout(req.user!.id, normalized);
    res.json({
      layout: normalizeDiscoverLayout(dbOps.getUserDiscoverLayout(req.user!.id)),
    });
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({
      error: "Failed to save discover layout",
      message: failure?.message,
    });
  }
});

router.patch("/me/lidarr-preferences", requireAuth, async (req, res) => {
  try {
    const user = userOps.getUserById(req.user!.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const hasRootFolderPath = Object.hasOwn(req.body, "rootFolderPath");
    const hasQualityProfileId = Object.hasOwn(req.body, "qualityProfileId");

    const nextRootFolderPath = hasRootFolderPath
      ? req.body.rootFolderPath === null
        ? null
        : normalizeRootFolderPath(req.body.rootFolderPath)
      : user.lidarrRootFolderPath;
    const nextQualityProfileId = hasQualityProfileId
      ? req.body.qualityProfileId === null
        ? null
        : normalizeQualityProfileId(req.body.qualityProfileId)
      : user.lidarrQualityProfileId;

    if (hasRootFolderPath && req.body.rootFolderPath !== null && !nextRootFolderPath) {
      return res.status(400).json({
        error: "Invalid Lidarr preferences",
        message: "rootFolderPath must be a non-empty string or null",
        field: "rootFolderPath",
      });
    }

    if (
      hasQualityProfileId &&
      req.body.qualityProfileId !== null &&
      nextQualityProfileId === null
    ) {
      return res.status(400).json({
        error: "Invalid Lidarr preferences",
        message: "qualityProfileId must be a numeric id or null",
        field: "qualityProfileId",
      });
    }

    const { lidarrClient } = await import("../services/lidarrClient.ts");
    if (!lidarrClient.isConfigured()) {
      if (nextRootFolderPath !== null || nextQualityProfileId !== null) {
        return res.status(503).json({
          error: "Lidarr is not configured",
          message: "Configure Lidarr before saving library defaults.",
        });
      }
      const updated = userOps.updateUser(req.user!.id, {
        lidarrRootFolderPath: null,
        lidarrQualityProfileId: null,
      });
      return res.json({
        configured: false,
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
      });
    }

    const summary = await lidarrClient.getArtistAddPreferenceSummary(user);
    if (
      nextRootFolderPath !== null &&
      !summary.rootFolders.some((folder) => folder.path === nextRootFolderPath)
    ) {
      return res.status(400).json({
        error: "Invalid Lidarr preferences",
        message: `Unknown Lidarr root folder: ${nextRootFolderPath}`,
        field: "rootFolderPath",
      });
    }
    if (
      nextQualityProfileId !== null &&
      !summary.qualityProfiles.some((profile) => profile.id === nextQualityProfileId)
    ) {
      return res.status(400).json({
        error: "Invalid Lidarr preferences",
        message: `Unknown Lidarr quality profile: ${nextQualityProfileId}`,
        field: "qualityProfileId",
      });
    }

    const updated = userOps.updateUser(req.user!.id, {
      lidarrRootFolderPath: nextRootFolderPath,
      lidarrQualityProfileId: nextQualityProfileId,
    });
    if (!updated) {
      return res.status(500).json({
        error: "Failed to save Lidarr preferences",
      });
    }

    const refreshedSummary = await lidarrClient.getArtistAddPreferenceSummary(updated);
    res.json(refreshedSummary);
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({
      error: "Failed to save Lidarr preferences",
      message: failure?.message,
    });
  }
});

router.post("/me/password", requireAuth, requireRecentAuth(), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: "New password required" });
    }
    const passwordValidation = requirePasswordStrength(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }
    const u = userOps.getUserById(req.user!.id);
    if (!u) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    if (u.hasLocalPassword && !verifyPassword(currentPassword || "", u.passwordHash)) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    const hash = hashPassword(newPassword);
    userOps.updateUser(req.user!.id, {
      passwordHash: hash,
      hasLocalPassword: true,
      subsonicPassword: newPassword,
    });
    deleteSessionsByUserId(req.user!.id);
    res.json({ success: true });
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({ error: "Failed to change password", message: failure?.message });
  }
});

router.delete("/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (req.user!.id === id) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }
    const existing = userOps.getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }
    deleteSessionsByUserId(id);
    userOps.deleteUser(id);
    dbOps.deleteUserTheme(id);
    dbOps.deleteDiscoveryCacheByPrefix(`${getUserDiscoveryNamespace(id)}:`);
    reconcileLocalBypassAfterUserMutation();
    res.json({ success: true });
  } catch (e) {
    const failure = asAppError(e);
    res.status(500).json({ error: "Failed to delete user", message: failure?.message });
  }
});

registerPlexLink(router);
registerIdentityLink(router);

type UserRecord = NonNullable<ReturnType<typeof userOps.getUserById>>;

export type DiscoverLayoutItem = { id: string; enabled: boolean };

export type UserListResponse = (ReturnType<typeof userOps.getAllUsers>[number] & {
  plexLink: ReturnType<typeof plexConnectionStore.getPublicStatus>;
  plexGlobalAccount: Awaited<ReturnType<typeof resolveGlobalPlexAccount>>;
})[];

export type CreateUserResponse = Pick<
  NonNullable<ReturnType<typeof userOps.createUser>>,
  "id" | "username" | "role" | "permissions" | "lidarrRootFolderPath" | "lidarrQualityProfileId"
>;

export type UpdateUserResponse =
  | ReturnType<typeof userOps.updateUser>
  | (Pick<
      UserRecord,
      | "id"
      | "username"
      | "role"
      | "listenHistoryProvider"
      | "listenHistoryUsername"
      | "listenHistoryUrl"
      | "lastfmUsername"
      | "lidarrRootFolderPath"
      | "lidarrQualityProfileId"
    > & { permissions?: UserRecord["permissions"] });

export type UserThemeResponse = { theme: ReturnType<typeof normalizeUserThemeDocument> | null };

export type SavedUserThemeResponse = { theme: ReturnType<typeof normalizeUserThemeDocument> };

export type DiscoverLayoutResponse = { layout: DiscoverLayoutItem[] | null };

export type SavedDiscoverLayoutResponse = { layout: DiscoverLayoutItem[] };

export type LidarrPreferencesResponse = Awaited<
  ReturnType<typeof lidarrClient.getArtistAddPreferenceSummary>
>;

export type UnconfiguredLidarrPreferencesResponse = {
  configured: false;
  rootFolders: [];
  qualityProfiles: [];
  savedDefaults: { rootFolderPath: string | null; qualityProfileId: number | null };
  fallbacks: { rootFolderPath: null; qualityProfileId: null };
};

export default router;
