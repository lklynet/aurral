import { Hono, type Context } from "hono";
import * as v from "valibot";
import { requireAdmin, requireAuth } from "../../middleware/guards.ts";
import { validateExternalUrl } from "../../middleware/urlValidator.ts";
import { validate } from "../../middleware/validate.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import {
  getDownloadClient,
  getDownloadClientSettings,
  testDownloadClient,
} from "../../services/download/downloadClientSettings.ts";
import { asAppError, type AppError } from "../../../lib/errors.ts";
import { isErrorStatus } from "../shared/errorStatus.ts";

function validateDownloadClientTestConfig(key: string, config: Record<string, unknown>) {
  const definition = Object.entries(getDownloadClientSettings()).find(
    ([name]) => name === key,
  )?.[1];
  const nextConfig = { ...config };

  const fields: readonly { key: string; type: string; label?: string }[] = definition?.fields || [];
  for (const field of fields) {
    if (field.type !== "url") continue;
    const value = nextConfig[field.key];
    if (value == null || String(value).trim() === "") continue;
    const validation = validateExternalUrl(value);
    if (!validation.valid) {
      throw new Error(`${field.label || field.key}: ${validation.error}`);
    }
    nextConfig[field.key] = validation.url;
  }

  return nextConfig;
}

function notificationFailureMessage(failure: AppError | undefined) {
  const data = failure?.response?.data;
  const body = typeof data === "object" && data !== null ? data : undefined;
  return (
    (body && Reflect.get(body, "description")) ||
    (body && Reflect.get(body, "error")) ||
    failure?.message
  );
}

const notificationFailureStatus = (failure: AppError | undefined) => {
  const status = failure?.response?.status;
  return isErrorStatus(status) ? status : 500;
};

async function clientTestResponse<
  E extends AppEnv,
  Result extends { configured: boolean; ok: boolean },
>(c: Context<E>, label: string, test: () => Promise<Result>, { warning = false } = {}) {
  try {
    const result = await test();
    if (!result.configured) return c.json(result, 400);
    if (!result.ok) return c.json(result, 502);
    return c.json(
      warning
        ? { success: true, warning: "warning" in result && result.warning === true, ...result }
        : { success: true, ...result },
      200,
    );
  } catch (error) {
    return c.json({ error: `${label} test failed`, message: asAppError(error)?.message }, 500);
  }
}

const clientConfig = v.record(v.string(), v.unknown());
const gotifyTarget = v.object({ url: v.optional(v.string()), token: v.optional(v.string()) });
const webhookTarget = v.object({
  url: v.optional(v.string()),
  headers: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
  body: v.optional(v.nullable(v.string())),
});

export default new Hono<AppEnv>()
  .basePath("/settings")
  .get("/download-clients", requireAuth, requireAdmin, (c) =>
    c.json({ clients: getDownloadClientSettings() }, 200),
  )
  .post(
    "/download-clients/:key/test",
    requireAuth,
    requireAdmin,
    validate("json", clientConfig),
    async (c) => {
      try {
        const key = c.req.param("key");
        const result = await testDownloadClient(
          key,
          validateDownloadClientTestConfig(key, c.req.valid("json")),
        );
        if (!result.configured) return c.json(result, 400);
        if (!result.ok) return c.json(result, 502);
        return c.json(
          { success: true, warning: "warning" in result && result.warning === true, ...result },
          200,
        );
      } catch (error) {
        return c.json({ error: "Connection failed", message: asAppError(error)?.message }, 400);
      }
    },
  )
  .post("/slskd/test", requireAuth, requireAdmin, (c) =>
    clientTestResponse(
      c,
      "slskd",
      () => getDownloadClient("slskd").testConnection({ force: true }),
      { warning: true },
    ),
  )
  .post("/prowlarr/test", requireAuth, requireAdmin, (c) =>
    clientTestResponse(c, "Prowlarr", async () => {
      const { prowlarrClient } = await import("../../services/prowlarrClient.ts");
      return prowlarrClient.testConnection({ force: true });
    }),
  )
  .get("/prowlarr/indexers", requireAuth, requireAdmin, async (c) => {
    try {
      const { prowlarrClient } = await import("../../services/prowlarrClient.ts");
      const indexers = await prowlarrClient.listUsenetIndexers({ force: true });
      return c.json({ indexers }, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to load Prowlarr indexers", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/nzbget/test", requireAuth, requireAdmin, (c) =>
    clientTestResponse(c, "NZBGet", () =>
      getDownloadClient("nzbget").testConnection({ force: true }),
    ),
  )
  .post("/sabnzbd/test", requireAuth, requireAdmin, (c) =>
    clientTestResponse(c, "SABnzbd", () =>
      getDownloadClient("sabnzbd").testConnection({ force: true }),
    ),
  )
  .post("/ytdlp/test", requireAuth, requireAdmin, (c) =>
    clientTestResponse(c, "yt-dlp", () =>
      getDownloadClient("ytdlp").testConnection({ force: true }),
    ),
  )
  .post("/gotify/test", requireAuth, requireAdmin, validate("json", gotifyTarget), async (c) => {
    try {
      const { sendGotifyTest } = await import("../../services/notificationService.ts");
      const input = c.req.valid("json");
      const url = input.url?.trim();
      const token = input.token?.trim();
      if (!url || !token) {
        return c.json(
          {
            error: "URL and token required",
            message: "Provide Gotify URL and application token in the request body",
          },
          400,
        );
      }
      const urlValidation = validateExternalUrl(url);
      if (!urlValidation.valid) return c.json({ error: urlValidation.error }, 400);
      await sendGotifyTest(urlValidation.url, token);
      return c.json({ success: true, message: "Test notification sent" }, 200);
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code === "MISSING_CONFIG") {
        return c.json({ error: "Invalid configuration", message: failure?.message }, 400);
      }
      return c.json(
        { error: "Gotify test failed", message: notificationFailureMessage(failure) },
        notificationFailureStatus(failure),
      );
    }
  })
  .post("/webhook/test", requireAuth, requireAdmin, validate("json", webhookTarget), async (c) => {
    const webhook = c.req.valid("json");
    const urlValidation = validateExternalUrl(webhook.url);
    if (!urlValidation.valid) return c.json({ error: urlValidation.error }, 400);

    try {
      const { sendWebhookTest } = await import("../../services/notificationService.ts");
      await sendWebhookTest({ ...webhook, url: urlValidation.url });
      return c.json({ success: true, message: "Test webhook sent" }, 200);
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        { error: "Webhook test failed", message: notificationFailureMessage(failure) },
        notificationFailureStatus(failure),
      );
    }
  });
