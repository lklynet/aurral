import { Hono, type Context } from "hono";
import * as v from "valibot";
import { dbOps } from "../db/helpers/index.ts";
import { noCache } from "../middleware/cacheHeaders.ts";
import { resolveRequestUser } from "../middleware/auth.ts";
import { validate } from "../middleware/validate.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { ensureDownloadFolderPath, listBrowseDirectory } from "../services/downloadFolderConfig.ts";
import { requestCredentials } from "./shared/requestCredentials.ts";
import { asAppError } from "../../lib/errors.ts";

function canBrowseFilesystem<E extends AppEnv>(c: Context<E>) {
  if (!dbOps.getSettings().onboardingComplete) {
    return true;
  }
  return resolveRequestUser(requestCredentials(c))?.role === "admin";
}

const pathInput = v.object({ path: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/filesystem")
  .get("/browse", noCache, validate("query", pathInput), (c) => {
    try {
      if (!canBrowseFilesystem(c)) {
        return c.json(
          { error: "Forbidden", message: "Admin access is required to browse storage paths." },
          403,
        );
      }
      return c.json(listBrowseDirectory(c.req.valid("query").path), 200);
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        {
          error: "browse_failed",
          message: failure?.message || "Failed to browse storage path.",
        },
        400,
      );
    }
  })
  .post("/ensure", noCache, validate("json", pathInput), (c) => {
    try {
      if (!canBrowseFilesystem(c)) {
        return c.json(
          { error: "Forbidden", message: "Admin access is required to browse storage paths." },
          403,
        );
      }
      const ensured = ensureDownloadFolderPath(c.req.valid("json").path);
      if (!ensured.valid) {
        return c.json(
          { error: "ensure_failed", message: ensured.error || "Failed to prepare folder path." },
          400,
        );
      }
      return c.json(
        { ...listBrowseDirectory(ensured.path), path: ensured.path, created: !!ensured.created },
        200,
      );
    } catch (error) {
      const failure = asAppError(error);
      return c.json(
        {
          error: "ensure_failed",
          message: failure?.message || "Failed to prepare folder path.",
        },
        400,
      );
    }
  });
