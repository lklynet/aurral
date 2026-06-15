import express from "express";
import bcrypt from "bcrypt";
import { userOps, dbOps } from "../config/db-helpers.js";
import { requireAuth, requireAdmin } from "../middleware/requirePermission.js";
import { reconcileLocalNetworkBypassSetting } from "../middleware/auth.js";
import { requirePasswordStrength } from "../middleware/validation.js";
import { deleteSessionsByUserId } from "../config/session-helpers.js";
import { websocketService } from "../services/websocketService.js";
import {
  getListenHistoryCacheNamespace,
  getListenHistoryProfile,
  hasListenHistoryProfile,
  listenHistoryProfilesEqual,
  normalizeListenHistoryProvider,
  normalizeListenHistoryUrl,
  normalizeListenHistoryUsername,
  resolveListenHistorySettings,
} from "../services/listeningHistory.js";
import { validateExternalUrl } from "../middleware/urlValidator.js";
import { normalizeKoitoBaseUrl } from "../services/koitoClient.js";

const buildListenHistoryUpdates = (body, existing) => {
  const hasLegacyLastfmUpdate = Object.hasOwn(body, "lastfmUsername");
  const hasListenHistoryProviderUpdate = Object.hasOwn(
    body,
    "listenHistoryProvider",
  );
  const hasListenHistoryUsernameUpdate = Object.hasOwn(
    body,
    "listenHistoryUsername",
  );
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

  if (provider === "koito") {
    const rawUrl = hasListenHistoryUrlUpdate
      ? body.listenHistoryUrl
      : existing.listenHistoryUrl;
    const trimmedUrl = normalizeListenHistoryUrl(rawUrl);
    if (!trimmedUrl) {
      return {
        listenHistoryProvider: "koito",
        listenHistoryUrl: null,
        listenHistoryUsername: null,
      };
    }
    const urlValidation = validateExternalUrl(trimmedUrl);
    if (!urlValidation.valid) {
      const error = new Error(urlValidation.error || "Invalid Koito URL");
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

const normalizeRootFolderPath = (value) => {
  const normalized = String(value || "").trim();
  return normalized || null;
};

const normalizeQualityProfileId = (value) => {
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
  { id: "recommended", enabled: true },
  { id: "globalTop", enabled: true },
  { id: "genreSections", enabled: true },
];

const FALLBACK_GENRE_SECTION_PREFIX = "fallbackGenre:";

const normalizeDiscoverLayout = (value) => {
  if (!Array.isArray(value)) return null;
  const defaultsById = new Map(
    DEFAULT_DISCOVER_LAYOUT.map((item) => [item.id, item]),
  );
  const seenDynamicIds = new Set();
  const normalized = [];
  for (const item of value) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    if (id.startsWith(FALLBACK_GENRE_SECTION_PREFIX)) {
      if (seenDynamicIds.has(id)) continue;
      seenDynamicIds.add(id);
      normalized.push({
        id,
        enabled: typeof item?.enabled === "boolean" ? item.enabled : true,
      });
      continue;
    }
    if (!defaultsById.has(id)) continue;
    normalized.push({
      id,
      enabled:
        typeof item?.enabled === "boolean"
          ? item.enabled
          : defaultsById.get(id).enabled,
    });
    defaultsById.delete(id);
  }
  for (const item of defaultsById.values()) {
    normalized.push({ ...item });
  }
  return normalized;
};

const clearOrphanedDiscoveryCache = (userId, existingProfile, nextProfile) => {
  if (
    !hasListenHistoryProfile(existingProfile) ||
    listenHistoryProfilesEqual(existingProfile, nextProfile)
  ) {
    return;
  }
  const existingNamespace = getListenHistoryCacheNamespace(existingProfile);
  if (!existingNamespace) return;
  const otherUsers = userOps
    .getAllListeningHistoryUsers()
    .filter(
      (user) =>
        user.id !== userId && listenHistoryProfilesEqual(user, existingProfile),
    );
  if (otherUsers.length === 0) {
    dbOps.deleteDiscoveryCacheByPrefix(`${existingNamespace}:`);
  }
};

router.get("/", requireAuth, requireAdmin, (req, res) => {
  try {
    const users = userOps.getAllUsers();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: "Failed to list users", message: e.message });
  }
});

router.post("/", requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password, role = "user", permissions } = req.body;
    const un = String(username || "").trim();
    if (!un || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    if (userOps.getUserByUsername(un)) {
      return res.status(409).json({ error: "Username already exists" });
    }
    const passwordValidation = requirePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }
    const hash = bcrypt.hashSync(password, 10);
    const perms = permissions
      ? { ...userOps.getDefaultPermissions(), ...permissions }
      : null;
    const created = userOps.createUser(un, hash, role, perms);
    if (!created) {
      return res.status(500).json({ error: "Failed to create user" });
    }
    reconcileLocalBypassAfterUserMutation();
    res
      .status(201)
      .json({
        id: created.id,
        username: created.username,
        role: created.role,
        permissions: created.permissions,
        lidarrRootFolderPath: created.lidarrRootFolderPath,
        lidarrQualityProfileId: created.lidarrQualityProfileId,
        discoverLayout: created.discoverLayout,
      });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to create user", message: e.message });
  }
});

router.patch("/:id", requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const isAdmin = req.user.role === "admin";
    const isSelf = req.user.id === id;
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const existing = userOps.getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }
    const { password, permissions, role } = req.body;
    const existingProfile = getListenHistoryProfile(existing);
    let listenHistoryUpdates = null;
    try {
      listenHistoryUpdates = buildListenHistoryUpdates(req.body, existing);
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        error: error.message || "Invalid listening history settings",
      });
    }
    const requestedProfile = getListenHistoryProfile({
      ...existing,
      ...(listenHistoryUpdates || {}),
    });
    clearOrphanedDiscoveryCache(id, existingProfile, requestedProfile);
    if (isSelf && !isAdmin) {
      if (permissions !== undefined || role !== undefined) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const updates = {};
      if (listenHistoryUpdates) {
        Object.assign(updates, listenHistoryUpdates);
      }
      if (password) {
        const { currentPassword } = req.body;
        if (!currentPassword) {
          return res
            .status(400)
            .json({ error: "currentPassword required to change password" });
        }
        if (!bcrypt.compareSync(currentPassword, existing.passwordHash)) {
          return res.status(401).json({ error: "Current password is incorrect" });
        }
        const passwordValidation = requirePasswordStrength(password);
        if (!passwordValidation.valid) {
          return res.status(400).json({ error: passwordValidation.error });
        }
        updates.passwordHash = bcrypt.hashSync(password, 10);
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
          discoverLayout: existing.discoverLayout,
        });
      }
      const updated = userOps.updateUser(id, updates);
      if (updates.passwordHash) {
        deleteSessionsByUserId(id);
      }
      return res.json(updated);
    }
    const updates = {};
    if (password) {
      const passwordValidation = requirePasswordStrength(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
      updates.passwordHash = bcrypt.hashSync(password, 10);
    }
    if (permissions !== undefined) updates.permissions = permissions;
    if (role !== undefined) updates.role = role;
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
        discoverLayout: existing.discoverLayout,
      });
    }
    const updated = userOps.updateUser(id, updates);
    reconcileLocalBypassAfterUserMutation();
    res.json(updated);
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to update user", message: e.message });
  }
});

const sendListenHistorySettings = (req, res) => {
  try {
    const user = userOps.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const settings = dbOps.getSettings();
    res.json(resolveListenHistorySettings(user, settings));
  } catch (e) {
    res.status(500).json({
      error: "Failed to get listening history settings",
      message: e.message,
    });
  }
};

router.get("/me/listening-history", requireAuth, sendListenHistorySettings);
router.get("/me/lastfm", requireAuth, sendListenHistorySettings);

router.get("/me/lidarr-preferences", requireAuth, async (req, res) => {
  try {
    const user = userOps.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const { lidarrClient } = await import("../services/lidarrClient.js");
    const summary = await lidarrClient.getArtistAddPreferenceSummary(user);
    res.json(summary);
  } catch (e) {
    res.status(500).json({
      error: "Failed to get Lidarr preferences",
      message: e.message,
    });
  }
});

router.get("/me/discover-layout", requireAuth, (req, res) => {
  try {
    const user = userOps.getUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const storedLayout = dbOps.getUserDiscoverLayout(req.user.id);
    res.json({
      layout: normalizeDiscoverLayout(storedLayout),
    });
  } catch (e) {
    res.status(500).json({
      error: "Failed to get discover layout",
      message: e.message,
    });
  }
});

router.patch("/me/discover-layout", requireAuth, (req, res) => {
  try {
    const user = userOps.getUserById(req.user.id);
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
    dbOps.setUserDiscoverLayout(req.user.id, normalized);
    res.json({
      layout: normalizeDiscoverLayout(dbOps.getUserDiscoverLayout(req.user.id)),
    });
  } catch (e) {
    res.status(500).json({
      error: "Failed to save discover layout",
      message: e.message,
    });
  }
});

router.patch("/me/lidarr-preferences", requireAuth, async (req, res) => {
  try {
    const user = userOps.getUserById(req.user.id);
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

    const { lidarrClient } = await import("../services/lidarrClient.js");
    if (!lidarrClient.isConfigured()) {
      if (nextRootFolderPath !== null || nextQualityProfileId !== null) {
        return res.status(503).json({
          error: "Lidarr is not configured",
          message: "Configure Lidarr before saving library defaults.",
        });
      }
      const updated = userOps.updateUser(req.user.id, {
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
      !summary.qualityProfiles.some(
        (profile) => profile.id === nextQualityProfileId,
      )
    ) {
      return res.status(400).json({
        error: "Invalid Lidarr preferences",
        message: `Unknown Lidarr quality profile: ${nextQualityProfileId}`,
        field: "qualityProfileId",
      });
    }

    const updated = userOps.updateUser(req.user.id, {
      lidarrRootFolderPath: nextRootFolderPath,
      lidarrQualityProfileId: nextQualityProfileId,
    });
    if (!updated) {
      return res.status(500).json({
        error: "Failed to save Lidarr preferences",
      });
    }

    const refreshedSummary = await lidarrClient.getArtistAddPreferenceSummary(
      updated,
    );
    res.json(refreshedSummary);
  } catch (e) {
    res.status(500).json({
      error: "Failed to save Lidarr preferences",
      message: e.message,
    });
  }
});

router.post("/me/password", requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: "New password required" });
    }
    const passwordValidation = requirePasswordStrength(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }
    const u = userOps.getUserById(req.user.id);
    if (!u || !bcrypt.compareSync(currentPassword || "", u.passwordHash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    userOps.updateUser(req.user.id, { passwordHash: hash });
    deleteSessionsByUserId(req.user.id);
    res.json({ success: true });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to change password", message: e.message });
  }
});

router.delete("/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (req.user.id === id) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }
    const existing = userOps.getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }
    deleteSessionsByUserId(id);
    userOps.deleteUser(id);
    reconcileLocalBypassAfterUserMutation();
    res.json({ success: true });
  } catch (e) {
    res
      .status(500)
      .json({ error: "Failed to delete user", message: e.message });
  }
});

export default router;
