import { Hono } from "hono";
import * as v from "valibot";
import { dbOps, userOps } from "../db/helpers/index.ts";
import { hashPassword } from "../middleware/passwordHash.ts";
import { defaultData } from "../config/constants.ts";
import { createSession } from "../config/session-helpers.ts";
import { requirePasswordStrength, reconcileLocalNetworkBypassSetting } from "../middleware/auth.ts";
import { validate } from "../middleware/validate.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validateDownloadFolderPath } from "../services/downloadFolderConfig.ts";
import { IngestSourceError } from "../services/libraryFiles/ingest.ts";
import { startIngest } from "../services/libraryFiles/operations.ts";
import {
  addReadOnlyFolder,
  ReadOnlyFolderError,
} from "../services/libraryFiles/readOnlyFolders.ts";
import { logger } from "../services/logger.ts";
import { asAppError } from "../../lib/errors.ts";

const completeBody = v.object({
  authUser: v.nullish(v.string()),
  authPassword: v.nullish(v.string()),
  security: v.nullish(
    v.object({
      localNetworkBypass: v.nullish(v.object({ enabled: v.optional(v.boolean()) })),
    }),
  ),
  downloadFolderPath: v.optional(v.string()),
  existingMusic: v.nullish(
    v.object({ path: v.string(), mode: v.picklist(["read-in-place", "import"]) }),
  ),
});

const addExistingMusic = ({ path, mode }: { path: string; mode: "read-in-place" | "import" }) =>
  mode === "import"
    ? startIngest({ sourcePath: path, mode: "copy", monitor: "none" })
    : addReadOnlyFolder(path);

export default new Hono<AppEnv>()
  .basePath("/onboarding")
  .use(async (c, next) => {
    if (dbOps.getSettings().onboardingComplete) {
      return c.json({ error: "Forbidden", message: "Onboarding has already been completed" }, 403);
    }
    await next();
  })
  .post("/complete", validate("json", completeBody), async (c) => {
    try {
      const { authUser, authPassword, security, downloadFolderPath, existingMusic } =
        c.req.valid("json");
      if (authPassword != null && authPassword.length > 0) {
        const passwordValidation = requirePasswordStrength(authPassword);
        if (!passwordValidation.valid) {
          return c.json({ error: passwordValidation.error }, 400);
        }
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

      const nextSettings = {
        ...current,
        integrations,
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

      if (existingMusic?.path.trim()) {
        try {
          await addExistingMusic({ ...existingMusic, path: existingMusic.path.trim() });
        } catch (error) {
          if (error instanceof ReadOnlyFolderError || error instanceof IngestSourceError) {
            return c.json({ error: error.message, message: error.message }, 400);
          }
          throw error;
        }
      }

      dbOps.updateSettings({ ...dbOps.getSettings(), onboardingComplete: true });

      const authUserFinal = integrations.general.authUser || "admin";
      const authPasswordFinal = integrations.general.authPassword || "";
      let token: string | null = null;
      if (authPasswordFinal && userOps.getAllUsers().length === 0) {
        const hash = hashPassword(authPasswordFinal);
        const user = userOps.createUser(
          authUserFinal,
          hash,
          "admin",
          null,
          true,
          true,
          authPasswordFinal,
        );
        if (user) {
          token = createSession(
            user.id,
            c.var.clientIp || null,
            c.req.header("user-agent") || null,
          ).token;
        }
      }

      reconcileLocalNetworkBypassSetting();

      const { enqueueDiscoveryRefresh } = await import("../services/discovery/refreshScheduler.ts");
      enqueueDiscoveryRefresh({ reason: "onboarding" });

      return c.json({ success: true, token }, 200);
    } catch (error) {
      const failure = asAppError(error);
      logger.error("onboarding", "Complete error:", { message: failure?.message });
      return c.json({ error: "Failed to save onboarding", message: failure?.message }, 500);
    }
  });
