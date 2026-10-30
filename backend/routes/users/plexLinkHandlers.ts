import { Hono } from "hono";
import * as v from "valibot";
import { db } from "../../config/db-sqlite.ts";
import { dbOps, userOps, userIdentityOps } from "../../db/helpers/index.ts";
import { isRecentlyAuthenticated } from "../../middleware/auth.ts";
import { requireAuth, requireAdmin, requireRecentAuth } from "../../middleware/guards.ts";
import { validate } from "../../middleware/validate.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { plexConnectionStore } from "../../services/plex/plexConnectionStore.ts";
import { playlistManager } from "../../services/playlists/playlistManager.ts";
import { logger } from "../../services/logger.ts";
import { asAppError } from "../../../lib/errors.ts";

type PlexConnection = NonNullable<ReturnType<typeof plexConnectionStore.getConnection>>;
type PlexLinkInput = NonNullable<Parameters<typeof plexConnectionStore.saveConnection>[1]>;
type PlexIdentityLink = Parameters<typeof userIdentityOps.replaceForUser>[1];
type PlexServerTokenOptions = {
  mismatchErrorMessage?: string;
  tolerateLookupFailure?: boolean;
  warnContext?: string;
};

function getGlobalPlexConfig() {
  return dbOps.getSettings()?.integrations?.plex || {};
}

export function isPlexLoginEnabled() {
  const plex = getGlobalPlexConfig();
  return plex.loginEnabled === true && !!plex.url && !!plex.token;
}

async function cleanupUserPlexPlaylistsSafely(
  userId: number,
  context: string,
  connection: ReturnType<typeof plexConnectionStore.getConnection> = null,
) {
  try {
    await playlistManager.cleanupUserPlexPlaylists(userId, connection);
  } catch (cleanupError) {
    const failure = asAppError(cleanupError);
    logger.warn("users", `Plex playlist cleanup ${context} failed:`, failure?.message);
  }
}

export async function disconnectUserPlex(
  userId: number,
  { force = false, context = "on unlink" } = {},
) {
  const plexIdentity = userIdentityOps
    .getForUser(userId)
    .find((identity) => identity.providerType === "plex");
  if (plexIdentity) {
    const user = userOps.getUserById(userId);
    const remaining = userIdentityOps.countForUser(userId) - 1;
    if (remaining <= 0 && !user?.hasLocalPassword && !force) {
      return {
        disconnected: false,
        requiresForce: true,
        error: "last_auth_method",
        message: "Removing Plex will leave this account without a usable sign-in method.",
      };
    }
  }

  await cleanupUserPlexPlaylistsSafely(userId, context);
  plexConnectionStore.clearConnection(userId);
  if (plexIdentity) userIdentityOps.unlink(plexIdentity.id);
  return { disconnected: true, forced: !!force };
}

async function cleanupPlexPlaylistsIfIdentityChanged(
  userId: number,
  previous: PlexConnection | null,
  linkType: PlexConnection["linkType"],
  plexAccountId: PlexConnection["plexAccountId"],
) {
  const identityChanged =
    previous &&
    (previous.linkType !== linkType ||
      String(previous.plexAccountId ?? "") !== String(plexAccountId ?? ""));
  if (!identityChanged) return;
  await cleanupUserPlexPlaylistsSafely(userId, "after relink", previous);
}

export function persistSelfPlexLink(
  userId: number,
  connection: PlexLinkInput,
  identity: PlexIdentityLink,
) {
  return db.transaction(() => {
    const saved = plexConnectionStore.saveConnection(userId, connection);
    userIdentityOps.replaceForUser(userId, identity);
    return saved;
  })();
}

// Resolves the token Plex actually accepts for the configured server: the
// account-level token if there's no server pin, otherwise the server-scoped
// access token from the matching resource. Skips the lookup entirely when no
// server is configured yet, since there is nothing to match against.
async function resolveServerAccessToken(
  token: string,
  clientId: string,
  machineIdentifier: ReturnType<typeof getGlobalPlexConfig>["machineIdentifier"],
  {
    mismatchErrorMessage,
    tolerateLookupFailure = false,
    warnContext = "",
  }: PlexServerTokenOptions = {},
) {
  if (!machineIdentifier) return { serverToken: token };
  const { PlexClient } = await import("../../services/plex.ts");
  try {
    const { servers } = await PlexClient.getResources(token, clientId);
    const match = (servers || []).find((s) => s.clientIdentifier === machineIdentifier);
    if (!match) return { error: mismatchErrorMessage };
    return { serverToken: match.accessToken || token };
  } catch (resourceError) {
    const failure = asAppError(resourceError);
    if (!tolerateLookupFailure) throw resourceError;
    logger.warn(
      "users",
      `Plex resource lookup failed${warnContext ? ` for ${warnContext}` : ""}:`,
      failure?.message,
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
    const { PlexClient } = await import("../../services/plex.ts");
    const identity = await PlexClient.validateToken(globalPlex.token, globalPlex.clientId);
    const plexUsername = identity?.username || identity?.title || null;
    if (plexUsername) {
      const settings = dbOps.getSettings();
      dbOps.updateSettings({
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

const pinBody = v.object({ forwardUrl: v.nullish(v.string()) });
const completeBody = v.object({
  pinId: v.optional(v.union([v.string(), v.number()])),
  code: v.optional(v.string()),
  clientId: v.optional(v.string()),
});
const managedBody = v.object({
  plexUserId: v.nullish(v.union([v.string(), v.number()])),
  plexUsername: v.nullish(v.string()),
  plexUuid: v.nullish(v.string()),
  pin: v.nullish(v.string()),
});
const unlinkQuery = v.object({ force: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/users")
  .get("/me/plex-link/status", requireAuth, async (c) => {
    try {
      const status = plexConnectionStore.getPublicStatus(c.var.user.id);
      const globalAccount = await resolveGlobalPlexAccount();
      const isGlobalAccountOwner =
        c.var.user.role === "admin" &&
        (globalAccount.configuredByUserId == null ||
          Number(globalAccount.configuredByUserId) === Number(c.var.user.id));
      return c.json({ ...status, globalAccount, isGlobalAccountOwner }, 200);
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to get Plex link status", message: failure?.message }, 500);
    }
  })
  .post("/me/plex-link/oauth/pin", requireAuth, validate("json", pinBody), async (c) => {
    try {
      const { PlexClient } = await import("../../services/plex.ts");
      const clientId = PlexClient.generateClientId();
      const { id, code } = await PlexClient.generatePin(clientId);
      return c.json(
        {
          pinId: id,
          code,
          clientId,
          authUrl: PlexClient.buildAuthUrl(clientId, code, c.req.valid("json").forwardUrl),
        },
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      logger.error("users", "Plex self-link PIN generation failed:", failure?.message);
      return c.json(
        { error: "Failed to start Plex authentication", message: failure?.message },
        500,
      );
    }
  })
  .post(
    "/me/plex-link/oauth/complete",
    requireAuth,
    requireRecentAuth(),
    validate("json", completeBody),
    async (c) => {
      try {
        const { PlexClient } = await import("../../services/plex.ts");
        const { pinId, code, clientId } = c.req.valid("json");
        if (!pinId || !code || !clientId) {
          return c.json({ error: "pinId, code and clientId are required" }, 400);
        }
        const token = await PlexClient.checkPin(pinId, code, clientId);
        if (!token) return c.json({ pending: true as const }, 200);

        const identity = await PlexClient.validateToken(token, clientId);
        if (!identity) {
          return c.json({ error: "Could not verify the Plex account" }, 400);
        }

        const globalPlex = getGlobalPlexConfig();
        if (!globalPlex.machineIdentifier) {
          return c.json(
            { error: "Connect and test Plex in Settings before linking your own account" },
            400,
          );
        }
        const tokenResult = await resolveServerAccessToken(
          token,
          clientId,
          globalPlex.machineIdentifier,
          {
            mismatchErrorMessage:
              "This Plex account does not have access to the configured Plex server",
          },
        );
        if (tokenResult.error) {
          return c.json({ error: tokenResult.error }, 400);
        }
        const serverToken = tokenResult.serverToken;

        const subject = identity.id != null ? String(identity.id) : null;
        if (!subject) {
          return c.json({ error: "Plex did not return a stable account identifier" }, 400);
        }
        const existingIdentity = userIdentityOps.findByProvider("plex", "plex", subject);
        if (existingIdentity && existingIdentity.userId !== c.var.user.id) {
          return c.json(
            { error: "This Plex account is already linked to another Aurral account" },
            409,
          );
        }

        const previousConnection = plexConnectionStore.getConnection(c.var.user.id);
        let saved;
        try {
          saved = persistSelfPlexLink(
            c.var.user.id,
            {
              linkType: "self",
              token: serverToken,
              clientId,
              plexAccountId: identity.id ?? null,
              plexUuid: identity.uuid || null,
              plexUsername: identity.username || identity.title || null,
            },
            {
              providerType: "plex",
              providerKey: "plex",
              subject,
              displayName: identity.username || identity.title || null,
            },
          );
        } catch (error) {
          const failure = asAppError(error);
          if (String(failure?.code || "").startsWith("SQLITE_CONSTRAINT")) {
            return c.json(
              { error: "This Plex account is already linked to another Aurral account" },
              409,
            );
          }
          throw error;
        }

        await cleanupPlexPlaylistsIfIdentityChanged(
          c.var.user.id,
          previousConnection,
          "self",
          identity.id,
        );

        return c.json(
          {
            connected: true as const,
            linkType: saved.linkType,
            plexUsername: saved.plexUsername,
            connectedAt: saved.connectedAt,
          },
          200,
        );
      } catch (error) {
        const failure = asAppError(error);
        logger.error("users", "Plex self-link completion failed:", failure?.message);
        return c.json(
          { error: "Failed to complete Plex connection", message: failure?.message },
          500,
        );
      }
    },
  )
  .delete("/me/plex-link", requireAuth, requireRecentAuth(), async (c) => {
    try {
      const result = await disconnectUserPlex(c.var.user.id);
      if (!result.disconnected) {
        return c.json({ error: result.error, message: result.message }, 400);
      }
      return c.json({ connected: false }, 200);
    } catch (e) {
      const failure = asAppError(e);
      return c.json({ error: "Failed to disconnect Plex", message: failure?.message }, 500);
    }
  })
  .get("/plex-link/home-users", requireAuth, requireAdmin, async (c) => {
    try {
      const { PlexClient } = await import("../../services/plex.ts");
      const globalPlex = getGlobalPlexConfig();
      if (!globalPlex.token || !globalPlex.clientId) {
        return c.json({ error: "Connect the global Plex account first" }, 400);
      }
      const homeUsers = await PlexClient.getHomeUsers(globalPlex.token, globalPlex.clientId);
      const linkedIds = plexConnectionStore.getAllLinkedPlexAccountIds();
      return c.json(
        {
          users: homeUsers.map((u) => ({
            ...u,
            alreadyLinked: linkedIds.has(String(u.id)),
          })),
        },
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      const status = failure?.response?.status;
      logger.error(
        "users",
        "Listing Plex Home users failed:",
        status ? `${status} ${JSON.stringify(failure?.response?.data)}` : failure?.message,
      );
      return c.json(
        {
          error: "Failed to list Plex Home users",
          message:
            status === 401
              ? "Plex rejected the admin token (401). Reconnect Plex in Settings."
              : failure?.message,
        },
        status === 401 ? 401 : 500,
      );
    }
  })
  .post(
    "/:id/plex-link/managed",
    requireAuth,
    requireAdmin,
    validate("json", managedBody),
    async (c) => {
      try {
        const id = parseInt(c.req.param("id"), 10);
        const target = userOps.getUserById(id);
        if (!target) return c.json({ error: "User not found" }, 404);

        const { plexUserId, plexUsername, plexUuid, pin } = c.req.valid("json");
        if (plexUserId == null) {
          return c.json({ error: "plexUserId is required" }, 400);
        }

        const globalPlex = getGlobalPlexConfig();
        if (!globalPlex.token || !globalPlex.clientId) {
          return c.json({ error: "Connect the global Plex account first" }, 400);
        }

        const { PlexClient } = await import("../../services/plex.ts");
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
          return c.json({ error: "Plex did not return a token for that user" }, 502);
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
          return c.json({ error: tokenResult.error }, 400);
        }
        const serverToken = tokenResult.serverToken;

        const previousConnection = plexConnectionStore.getConnection(id);

        const saved = plexConnectionStore.saveConnection(id, {
          linkType: "managed",
          token: serverToken,
          clientId: targetClientId,
          plexAccountId: plexUserId,
          plexUuid: plexUuid || null,
          plexUsername: plexUsername || null,
          linkedByAdminId: c.var.user.id,
        });
        await cleanupPlexPlaylistsIfIdentityChanged(id, previousConnection, "managed", plexUserId);
        return c.json(
          {
            connected: true as const,
            linkType: saved.linkType,
            plexUsername: saved.plexUsername,
            connectedAt: saved.connectedAt,
          },
          200,
        );
      } catch (error) {
        const failure = asAppError(error);
        const status = failure?.response?.status;
        logger.error(
          "users",
          "Managed Plex user link failed:",
          status ? `${status} ${JSON.stringify(failure?.response?.data)}` : failure?.message,
        );
        return c.json(
          { error: "Failed to link managed Plex user", message: failure?.message },
          status === 401 ? 401 : 500,
        );
      }
    },
  )
  .delete(
    "/:id/plex-link",
    requireAuth,
    requireAdmin,
    validate("query", unlinkQuery),
    async (c) => {
      try {
        const id = parseInt(c.req.param("id"), 10);
        const target = userOps.getUserById(id);
        if (!target) return c.json({ error: "User not found" }, 404);
        const force = (c.req.valid("query").force || "").toLowerCase() === "true";
        if (force && !isRecentlyAuthenticated(c.req.header("authorization"))) {
          return c.json(
            { error: "reauth_required", message: "Please confirm your credentials to continue" },
            401,
          );
        }
        const result = await disconnectUserPlex(id, { force, context: "on admin unlink" });
        if (!result.disconnected) {
          return c.json(
            {
              error: result.error,
              message: result.message,
              requiresForce: true,
              username: target.username,
            },
            409,
          );
        }
        if (result.forced) {
          logger.warn(
            "security-audit",
            "Administrator forcibly removed a user's final sign-in method",
            {
              administratorUserId: c.var.user.id,
              targetUserId: id,
              targetUsername: target.username,
              provider: "plex",
            },
          );
        }
        return c.json({ connected: false, forced: result.forced }, 200);
      } catch (e) {
        const failure = asAppError(e);
        return c.json({ error: "Failed to unlink Plex", message: failure?.message }, 500);
      }
    },
  );
