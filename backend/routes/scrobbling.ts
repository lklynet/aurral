import { Hono } from "hono";
import * as v from "valibot";
import { listenbrainzValidateToken } from "../services/apiClients/index.ts";
import { requireAuth, requireUserAccount } from "../middleware/guards.ts";
import { validate } from "../middleware/validate.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validateExternalUrl } from "../services/urlValidator.ts";
import { getKoitoListenBrainzBaseUrl, normalizeKoitoBaseUrl } from "../services/koitoClient.ts";
import { scrobbleConnectionStore } from "../services/scrobbleConnectionStore.ts";
import { logger } from "../services/logger.ts";
import { requestUserDiscoveryRefresh } from "../services/discovery/index.ts";
import {
  getListenHistory,
  updateListenHistory,
  type ListenHistoryProvider,
} from "../services/listeningHistory.ts";
import { asAppError } from "../../lib/errors.ts";

const providerErrorStatus = (error: unknown) => {
  const status = Number(asAppError(error)?.response?.status);
  return status >= 400 && status < 500 ? 400 : 502;
};
const useForHistory = (userId: number, provider: ListenHistoryProvider, account: string | null) => {
  if (!account || getListenHistory(userId)[provider]) return;
  updateListenHistory(userId, { [provider]: account });
  requestUserDiscoveryRefresh(userId, { reason: "listening_history" });
};
const tokenBody = v.object({ token: v.optional(v.string()) });
const koitoBody = v.object({ url: v.optional(v.string()), token: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/scrobbling")
  .get("/status", requireAuth, (c) =>
    c.json(scrobbleConnectionStore.getPublicStatus(c.var.user.id), 200),
  )
  .get("/listenbrainz/link", requireAuth, (c) => {
    const connection = scrobbleConnectionStore.getConnection(c.var.user.id, "listenbrainz");
    return c.json(
      { connected: Boolean(connection), displayName: connection?.displayName || null },
      200,
    );
  })
  .put(
    "/listenbrainz/link",
    requireAuth,
    requireUserAccount,
    validate("json", tokenBody),
    async (c) => {
      const token = (c.req.valid("json").token || "").trim();
      if (!token) return c.json({ error: "Token is required" }, 400);
      let validation;
      try {
        validation = await listenbrainzValidateToken(token);
      } catch (error) {
        const failure = asAppError(error);
        logger.warn("scrobbling", "ListenBrainz token validation failed", {
          message: failure?.message || String(error),
          status: failure?.response?.status || null,
        });
        const status = providerErrorStatus(error);
        return c.json(
          { error: status === 400 ? "Invalid token" : "ListenBrainz is unavailable" },
          status,
        );
      }
      if (!validation?.valid) return c.json({ error: "Invalid token" }, 400);
      try {
        const connection = scrobbleConnectionStore.saveConnection(c.var.user.id, "listenbrainz", {
          token,
          displayName: validation.user_name,
        });
        useForHistory(c.var.user.id, "listenbrainz", connection!.displayName);
        return c.json({ connected: true as const, displayName: connection!.displayName }, 200);
      } catch (error) {
        const failure = asAppError(error);
        logger.error("scrobbling", "ListenBrainz connection could not be saved", {
          message: failure?.message || String(error),
        });
        return c.json({ error: "ListenBrainz connection could not be saved" }, 500);
      }
    },
  )
  .delete("/listenbrainz/link", requireAuth, (c) => {
    scrobbleConnectionStore.deleteConnection(c.var.user.id, "listenbrainz");
    return c.body(null, 204);
  })
  .put("/koito/link", requireAuth, requireUserAccount, validate("json", koitoBody), async (c) => {
    const body = c.req.valid("json");
    const rawUrl = (body.url || getListenHistory(c.var.user.id).koito || "").trim();
    const validation = validateExternalUrl(rawUrl);
    const token = (body.token || "").trim();
    if (!validation.valid || !token) {
      return c.json({ error: validation.error || "Token is required" }, 400);
    }
    const baseUrl = normalizeKoitoBaseUrl(validation.url);
    try {
      const tokenValidation = await listenbrainzValidateToken(
        token,
        getKoitoListenBrainzBaseUrl(baseUrl),
      );
      if (!tokenValidation?.valid) return c.json({ error: "Invalid Koito API key" }, 400);
    } catch (error) {
      const failure = asAppError(error);
      logger.warn("scrobbling", "Koito token validation failed", {
        message: failure?.message || String(error),
        status: failure?.response?.status || null,
      });
      const status = providerErrorStatus(error);
      return c.json(
        { error: status === 400 ? "Invalid Koito API key" : "Koito is unavailable" },
        status,
      );
    }
    try {
      const connection = scrobbleConnectionStore.saveConnection(c.var.user.id, "koito", {
        token,
        baseUrl,
        displayName: new URL(baseUrl).host,
      });
      useForHistory(c.var.user.id, "koito", baseUrl);
      return c.json({ connected: true as const, displayName: connection!.displayName }, 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("scrobbling", "Koito connection could not be saved", {
        message: failure?.message || String(error),
      });
      return c.json({ error: "Koito connection could not be saved" }, 500);
    }
  })
  .delete("/koito/link", requireAuth, (c) => {
    scrobbleConnectionStore.deleteConnection(c.var.user.id, "koito");
    return c.body(null, 204);
  });
