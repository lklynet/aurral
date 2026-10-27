import { Hono } from "hono";
import * as v from "valibot";
import { dbOps, userOps } from "../db/helpers/index.ts";
import { hashPassword } from "../middleware/passwordHash.ts";
import { defaultData } from "../config/constants.ts";
import { requirePasswordStrength, reconcileLocalNetworkBypassSetting } from "../middleware/auth.ts";
import { validate } from "../middleware/validate.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validateDownloadFolderPath } from "../services/downloadFolderConfig.ts";
import { logger } from "../services/logger.ts";
import { stripTrailingSlashes } from "../services/textUtils.ts";
import { navidromeConnectionError, navidromeTestBody } from "./shared/navidromeTest.ts";
import { isErrorStatus } from "./shared/errorStatus.ts";
import {
  testLidarrConnection as lidarrTest,
  fetchQualityProfiles,
  fetchMetadataProfiles,
} from "../services/lidarrSettingsService.ts";
import { asAppError, type AppError } from "../../lib/errors.ts";

const failureStatus = (failure: AppError | undefined) =>
  isErrorStatus(failure?.statusCode) ? failure.statusCode : 400;

const lidarrCredentials = v.object({
  url: v.optional(v.string()),
  apiKey: v.optional(v.string()),
});

const credentialsOf = ({ url, apiKey }: v.InferOutput<typeof lidarrCredentials>) => ({
  url: stripTrailingSlashes((url || "").trim()),
  apiKey: (apiKey || "").trim(),
});

const profileId = v.nullish(v.union([v.string(), v.number()]));

const completeBody = v.object({
  authUser: v.nullish(v.string()),
  authPassword: v.nullish(v.string()),
  lidarr: v.nullish(
    v.object({
      url: v.optional(v.string()),
      apiKey: v.optional(v.string()),
      qualityProfileId: profileId,
      metadataProfileId: profileId,
      defaultMonitorOption: v.nullish(v.string()),
      searchOnAdd: v.optional(v.boolean()),
    }),
  ),
  security: v.nullish(
    v.object({
      localNetworkBypass: v.nullish(v.object({ enabled: v.optional(v.boolean()) })),
    }),
  ),
  downloadFolderPath: v.optional(v.string()),
});

type LidarrProfilesInput = {
  url?: string;
  apiKey?: string;
  qualityProfileId?: string | number | null;
  metadataProfileId?: string | number | null;
};

async function resolveLidarrProfiles(lidarr: LidarrProfilesInput) {
  let qualityProfileId =
    lidarr.qualityProfileId != null ? parseInt(String(lidarr.qualityProfileId), 10) || null : null;
  let metadataProfileId =
    lidarr.metadataProfileId != null
      ? parseInt(String(lidarr.metadataProfileId), 10) || null
      : null;
  if (qualityProfileId && metadataProfileId) {
    return { qualityProfileId, metadataProfileId };
  }
  const { url, apiKey } = credentialsOf(lidarr);
  if (!url || !apiKey) return { qualityProfileId, metadataProfileId };
  try {
    const [qualityProfiles, metadataProfiles] = await Promise.all([
      qualityProfileId ? null : fetchQualityProfiles({ url, apiKey }),
      metadataProfileId ? null : fetchMetadataProfiles({ url, apiKey }),
    ]);
    if (!qualityProfileId && Array.isArray(qualityProfiles) && qualityProfiles[0]?.id != null) {
      qualityProfileId = parseInt(String(qualityProfiles[0].id), 10) || null;
    }
    if (!metadataProfileId && Array.isArray(metadataProfiles) && metadataProfiles[0]?.id != null) {
      metadataProfileId = parseInt(String(metadataProfiles[0].id), 10) || null;
    }
  } catch (error) {
    const failure = asAppError(error);
    logger.warn("onboarding", "Could not auto-pick Lidarr profiles:", {
      message: failure?.message,
    });
  }
  return { qualityProfileId, metadataProfileId };
}

export default new Hono<AppEnv>()
  .basePath("/onboarding")
  .use(async (c, next) => {
    if (dbOps.getSettings().onboardingComplete) {
      return c.json({ error: "Forbidden", message: "Onboarding has already been completed" }, 403);
    }
    await next();
  })
  .post("/lidarr/profiles", validate("json", lidarrCredentials), async (c) => {
    try {
      return c.json(await fetchQualityProfiles(credentialsOf(c.req.valid("json"))), 200);
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        { error: "Failed to fetch Lidarr quality profiles", message: failure?.message },
        failureStatus(failure),
      );
    }
  })
  .post("/lidarr/metadata-profiles", validate("json", lidarrCredentials), async (c) => {
    try {
      return c.json(await fetchMetadataProfiles(credentialsOf(c.req.valid("json"))), 200);
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        { error: "Failed to fetch Lidarr metadata profiles", message: failure?.message },
        failureStatus(failure),
      );
    }
  })
  .post("/lidarr/test", validate("json", lidarrCredentials), async (c) => {
    try {
      const result = await lidarrTest(credentialsOf(c.req.valid("json")));
      if (result.connected) {
        return c.json({ success: true, message: "Connection successful" }, 200);
      }
      return c.json({ error: result.error || "Connection failed" }, 400);
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        { error: "Connection failed", message: failure?.message },
        failureStatus(failure),
      );
    }
  })
  .post("/navidrome/test", validate("json", navidromeTestBody), async (c) => {
    const failure = await navidromeConnectionError(c.req.valid("json"));
    return failure
      ? c.json(failure, 400)
      : c.json({ success: true, message: "Connection successful" }, 200);
  })
  .post("/complete", validate("json", completeBody), async (c) => {
    try {
      const { authUser, authPassword, lidarr, security, downloadFolderPath } = c.req.valid("json");
      if (authPassword != null && authPassword.length > 0) {
        const passwordValidation = requirePasswordStrength(authPassword);
        if (!passwordValidation.valid) {
          return c.json({ error: passwordValidation.error }, 400);
        }
      }

      if (lidarr != null && (!lidarr.url || !lidarr.apiKey)) {
        return c.json(
          {
            error: "Lidarr connection is incomplete",
            message: "Enter both the Lidarr URL and API key, or skip Lidarr for now.",
          },
          400,
        );
      }

      const current = dbOps.getSettings();
      const integrations = {
        ...(current.integrations || defaultData.settings.integrations || {}),
        general: {
          ...(current.integrations?.general || {}),
          authUser:
            authUser != null ? authUser.trim() : current.integrations?.general?.authUser || "admin",
          authPassword:
            authPassword != null ? authPassword : current.integrations?.general?.authPassword || "",
        },
      };

      if (lidarr != null && lidarr.url && lidarr.apiKey) {
        const profiles = await resolveLidarrProfiles(lidarr);
        integrations.lidarr = {
          ...(current.integrations?.lidarr || {}),
          url: stripTrailingSlashes(lidarr.url.trim()),
          apiKey: lidarr.apiKey.trim(),
          qualityProfileId: profiles.qualityProfileId,
          metadataProfileId: profiles.metadataProfileId,
          defaultMonitorOption:
            lidarr.defaultMonitorOption != null
              ? lidarr.defaultMonitorOption
              : current.integrations?.lidarr?.defaultMonitorOption || "none",
          searchOnAdd: lidarr.searchOnAdd === true,
        };
      }

      const nextSettings = {
        ...current,
        integrations,
        onboardingComplete: true,
        security: {
          ...(current.security || defaultData.settings.security || {}),
          localNetworkBypass: {
            enabled: security?.localNetworkBypass?.enabled === true,
          },
        },
      };

      if (downloadFolderPath !== undefined && downloadFolderPath.trim()) {
        const validation = validateDownloadFolderPath(downloadFolderPath, undefined, {
          create: true,
        });
        if (!validation.valid) {
          return c.json({ error: validation.error, message: validation.error }, 400);
        }
        nextSettings.downloadFolderPath = validation.path;
      }

      dbOps.updateSettings(nextSettings);

      const authUserFinal = integrations?.general?.authUser || "admin";
      const authPasswordFinal = integrations?.general?.authPassword || "";
      if (authPasswordFinal && userOps.getAllUsers().length === 0) {
        const hash = hashPassword(authPasswordFinal);
        userOps.createUser(authUserFinal, hash, "admin", null, true, true, authPasswordFinal);
      }

      reconcileLocalNetworkBypassSetting();

      if (integrations?.lidarr?.apiKey) {
        const { enqueueDiscoveryRefresh } =
          await import("../services/discovery/refreshScheduler.ts");
        enqueueDiscoveryRefresh({ reason: "onboarding" });
      }

      return c.json({ success: true }, 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("onboarding", "Complete error:", { message: failure?.message });
      return c.json({ error: "Failed to save onboarding", message: failure?.message }, 500);
    }
  });
