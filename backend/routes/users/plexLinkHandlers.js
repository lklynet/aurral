import { dbOps, userOps, userIdentityOps } from "../../db/helpers/index.js";
import { requireAuth, requireAdmin, requireRecentAuth } from "../../middleware/requirePermission.js";
import { plexConnectionStore } from "../../services/plex/plexConnectionStore.js";
import { playlistManager } from "../../services/weeklyFlow/weeklyFlowPlaylistManager.js";
import { logger } from "../../services/logger.js";

function getGlobalPlexConfig() {
  return dbOps.getSettings()?.integrations?.plex || {};
}

export function isPlexLoginEnabled() {
  const plex = getGlobalPlexConfig();
  return plex.loginEnabled === true && !!plex.url && !!plex.token;
}

async function cleanupUserPlexPlaylistsSafely(userId, context) {
  try {
    await playlistManager.cleanupUserPlexPlaylists(userId);
  } catch (cleanupError) {
    logger.warn("users", `Plex playlist cleanup ${context} failed:`, cleanupError.message);
  }
}

async function cleanupPlexPlaylistsIfIdentityChanged(userId, linkType, plexAccountId) {
  const previous = plexConnectionStore.getConnection(userId);
  const identityChanged =
    previous &&
    (previous.linkType !== linkType ||
      String(previous.plexAccountId ?? "") !== String(plexAccountId ?? ""));
  if (!identityChanged) return;
  await cleanupUserPlexPlaylistsSafely(userId, "before relink");
}

// Resolves the token Plex actually accepts for the configured server: the
// account-level token if there's no server pin, otherwise the server-scoped
// access token from the matching resource. Skips the lookup entirely when no
// server is configured yet, since there is nothing to match against.
async function resolveServerAccessToken(
  token,
  clientId,
  machineIdentifier,
  { mismatchErrorMessage, tolerateLookupFailure = false, warnContext = "" } = {},
) {
  if (!machineIdentifier) return { serverToken: token };
  const { PlexClient } = await import("../../services/plex.js");
  try {
    const { servers } = await PlexClient.getResources(token, clientId);
    const match = (servers || []).find((s) => s.clientIdentifier === machineIdentifier);
    if (!match) return { error: mismatchErrorMessage };
    return { serverToken: match.accessToken || token };
  } catch (resourceError) {
    if (!tolerateLookupFailure) throw resourceError;
    logger.warn(
      "users",
      `Plex resource lookup failed${warnContext ? ` for ${warnContext}` : ""}:`,
      resourceError?.message,
    );
    return { serverToken: token };
  }
}

export async function resolveGlobalPlexAccount() {
  const globalPlex = getGlobalPlexConfig();
  const configuredByUserId = globalPlex.configuredByUserId ?? null;
  const configured = Boolean(globalPlex.url && globalPlex.token);
  if (!configured) return { configured: false, plexUsername: null, configuredByUserId };
  if (globalPlex.plexUsername) {
    return { configured: true, plexUsername: globalPlex.plexUsername, configuredByUserId };
  }
  try {
    const { PlexClient } = await import("../../services/plex.js");
    const identity = await PlexClient.validateToken(globalPlex.token, globalPlex.clientId);
    const plexUsername = identity?.username || identity?.title || null;
    if (plexUsername) {
      const settings = dbOps.getSettings();
      dbOps.updateSettings({
        ...settings,
        integrations: {
          ...settings.integrations,
          plex: { ...settings.integrations.plex, plexUsername },
        },
      });
    }
    return { configured: true, plexUsername, configuredByUserId };
  } catch {
    return { configured: true, plexUsername: null, configuredByUserId };
  }
}

export function registerPlexLink(router) {
  router.get("/me/plex-link/status", requireAuth, async (req, res) => {
    try {
      const status = plexConnectionStore.getPublicStatus(req.user.id);
      const globalAccount = await resolveGlobalPlexAccount();
      const isGlobalAccountOwner =
        req.user.role === "admin" &&
        (globalAccount.configuredByUserId == null ||
          Number(globalAccount.configuredByUserId) === Number(req.user.id));
      res.json({ ...status, globalAccount, isGlobalAccountOwner });
    } catch (e) {
      res.status(500).json({ error: "Failed to get Plex link status", message: e.message });
    }
  });

  router.post("/me/plex-link/oauth/pin", requireAuth, async (req, res) => {
    try {
      const { PlexClient } = await import("../../services/plex.js");
      const clientId = PlexClient.generateClientId();
      const { id, code } = await PlexClient.generatePin(clientId);
      const forwardUrl = req.body?.forwardUrl;
      res.json({
        pinId: id,
        code,
        clientId,
        authUrl: PlexClient.buildAuthUrl(clientId, code, forwardUrl),
      });
    } catch (error) {
      logger.error("users", "Plex self-link PIN generation failed:", error.message);
      res.status(500).json({
        error: "Failed to start Plex authentication",
        message: error.message,
      });
    }
  });

  router.post("/me/plex-link/oauth/complete", requireAuth, requireRecentAuth(), async (req, res) => {
    try {
      const { PlexClient } = await import("../../services/plex.js");
      const { pinId, code, clientId } = req.body || {};
      if (!pinId || !code || !clientId) {
        return res.status(400).json({ error: "pinId, code and clientId are required" });
      }
      const token = await PlexClient.checkPin(pinId, code, clientId);
      if (!token) return res.json({ pending: true });

      const identity = await PlexClient.validateToken(token, clientId);
      if (!identity) {
        return res.status(400).json({ error: "Could not verify the Plex account" });
      }

      const globalPlex = getGlobalPlexConfig();
      if (!globalPlex.machineIdentifier) {
        return res.status(400).json({
          error: "Connect and test Plex in Settings before linking your own account",
        });
      }
      const tokenResult = await resolveServerAccessToken(token, clientId, globalPlex.machineIdentifier, {
        mismatchErrorMessage: "This Plex account does not have access to the configured Plex server",
      });
      if (tokenResult.error) {
        return res.status(400).json({ error: tokenResult.error });
      }
      const serverToken = tokenResult.serverToken;

      const subject = identity.id != null ? String(identity.id) : null;
      if (subject) {
        const existingIdentity = userIdentityOps.findByProvider("plex", "plex", subject);
        if (existingIdentity && existingIdentity.userId !== req.user.id) {
          return res.status(409).json({
            error: "This Plex account is already linked to another Aurral account",
          });
        }
      }

      await cleanupPlexPlaylistsIfIdentityChanged(req.user.id, "self", identity.id);

      const saved = plexConnectionStore.saveConnection(req.user.id, {
        linkType: "self",
        token: serverToken,
        clientId,
        plexAccountId: identity.id ?? null,
        plexUuid: identity.uuid || null,
        plexUsername: identity.username || identity.title || null,
      });

      if (subject && !userIdentityOps.findByProvider("plex", "plex", subject)) {
        userIdentityOps.link(req.user.id, {
          providerType: "plex",
          providerKey: "plex",
          subject,
          displayName: identity.username || identity.title || null,
        });
      }

      res.json({
        connected: true,
        linkType: saved.linkType,
        plexUsername: saved.plexUsername,
        connectedAt: saved.connectedAt,
      });
    } catch (error) {
      logger.error("users", "Plex self-link completion failed:", error.message);
      res.status(500).json({
        error: "Failed to complete Plex connection",
        message: error.message,
      });
    }
  });

  router.delete("/me/plex-link", requireAuth, requireRecentAuth(), async (req, res) => {
    try {
      const plexIdentity = userIdentityOps
        .getForUser(req.user.id)
        .find((identity) => identity.providerType === "plex");
      if (plexIdentity) {
        const user = userOps.getUserById(req.user.id);
        const remaining = userIdentityOps.countForUser(req.user.id) - 1;
        if (remaining <= 0 && !user?.hasLocalPassword) {
          return res.status(400).json({
            error: "last_auth_method",
            message:
              "This is your only way to sign in. Set a local password or link another account before removing it.",
          });
        }
      }

      await cleanupUserPlexPlaylistsSafely(req.user.id, "on unlink");
      plexConnectionStore.clearConnection(req.user.id);
      if (plexIdentity) {
        userIdentityOps.unlink(plexIdentity.id);
      }
      res.json({ connected: false });
    } catch (e) {
      res.status(500).json({ error: "Failed to disconnect Plex", message: e.message });
    }
  });

  router.get("/plex-link/home-users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { PlexClient } = await import("../../services/plex.js");
      const globalPlex = getGlobalPlexConfig();
      if (!globalPlex.token || !globalPlex.clientId) {
        return res.status(400).json({ error: "Connect the global Plex account first" });
      }
      const homeUsers = await PlexClient.getHomeUsers(globalPlex.token, globalPlex.clientId);
      const linkedIds = plexConnectionStore.getAllLinkedPlexAccountIds();
      res.json({
        users: homeUsers.map((u) => ({
          ...u,
          alreadyLinked: linkedIds.has(String(u.id)),
        })),
      });
    } catch (error) {
      const status = error.response?.status;
      logger.error(
        "users",
        "Listing Plex Home users failed:",
        status ? `${status} ${JSON.stringify(error.response?.data)}` : error.message,
      );
      res.status(status === 401 ? 401 : 500).json({
        error: "Failed to list Plex Home users",
        message:
          status === 401
            ? "Plex rejected the admin token (401). Reconnect Plex in Settings."
            : error.message,
      });
    }
  });

  router.post("/:id/plex-link/managed", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const target = userOps.getUserById(id);
      if (!target) return res.status(404).json({ error: "User not found" });

      const { plexUserId, plexUsername, plexUuid, pin } = req.body || {};
      if (plexUserId == null) {
        return res.status(400).json({ error: "plexUserId is required" });
      }

      const globalPlex = getGlobalPlexConfig();
      if (!globalPlex.token || !globalPlex.clientId) {
        return res.status(400).json({ error: "Connect the global Plex account first" });
      }

      const { PlexClient } = await import("../../services/plex.js");
      const existingManaged = plexConnectionStore.getConnection(id);
      const targetClientId =
        existingManaged?.linkType === "managed" &&
        existingManaged.clientId &&
        existingManaged.clientId !== globalPlex.clientId
          ? existingManaged.clientId
          : PlexClient.generateClientId();
      const token = await PlexClient.switchHomeUser(
        plexUserId,
        globalPlex.token,
        globalPlex.clientId,
        targetClientId,
        pin || undefined,
      );
      if (!token) {
        return res.status(502).json({ error: "Plex did not return a token for that user" });
      }

      const tokenResult = await resolveServerAccessToken(
        token,
        targetClientId,
        globalPlex.machineIdentifier,
        {
          mismatchErrorMessage:
            "This Plex Home user does not have access to the configured Plex server",
          tolerateLookupFailure: true,
          warnContext: `managed user ${plexUserId}`,
        },
      );
      if (tokenResult.error) {
        return res.status(400).json({ error: tokenResult.error });
      }
      const serverToken = tokenResult.serverToken;

      await cleanupPlexPlaylistsIfIdentityChanged(id, "managed", plexUserId);

      const saved = plexConnectionStore.saveConnection(id, {
        linkType: "managed",
        token: serverToken,
        clientId: targetClientId,
        plexAccountId: plexUserId,
        plexUuid: plexUuid || null,
        plexUsername: plexUsername || null,
        linkedByAdminId: req.user.id,
      });
      res.json({
        connected: true,
        linkType: saved.linkType,
        plexUsername: saved.plexUsername,
        connectedAt: saved.connectedAt,
      });
    } catch (error) {
      const status = error.response?.status;
      logger.error(
        "users",
        "Managed Plex user link failed:",
        status ? `${status} ${JSON.stringify(error.response?.data)}` : error.message,
      );
      res.status(status === 401 ? 401 : 500).json({
        error: "Failed to link managed Plex user",
        message: error.message,
      });
    }
  });

  router.delete("/:id/plex-link", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const target = userOps.getUserById(id);
      if (!target) return res.status(404).json({ error: "User not found" });
      await cleanupUserPlexPlaylistsSafely(id, "on unlink");
      plexConnectionStore.clearConnection(id);
      const adminPlexIdentity = userIdentityOps
        .getForUser(id)
        .find((identity) => identity.providerType === "plex");
      if (adminPlexIdentity) {
        userIdentityOps.unlink(adminPlexIdentity.id);
      }
      res.json({ connected: false });
    } catch (e) {
      res.status(500).json({ error: "Failed to unlink Plex", message: e.message });
    }
  });
}
