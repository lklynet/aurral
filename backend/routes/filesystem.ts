import express from "express";
import type { Request } from "express";
import { dbOps } from "../db/helpers/index.ts";
import { noCache } from "../middleware/cache.ts";
import { resolveRequestUser } from "../middleware/auth.ts";
import { ensureDownloadFolderPath, listBrowseDirectory } from "../services/downloadFolderConfig.ts";
import { asAppError } from "../../lib/errors.ts";

const router = express.Router();

function canBrowseFilesystem(req: Request) {
  const settings = dbOps.getSettings();
  if (!settings.onboardingComplete) {
    return true;
  }
  const user = resolveRequestUser(req);
  return user?.role === "admin";
}

router.get("/browse", noCache, (req, res) => {
  try {
    if (!canBrowseFilesystem(req)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Admin access is required to browse storage paths.",
      });
    }
    const result = listBrowseDirectory(req.query.path);
    return res.json(result);
  } catch (error) {
    const failure = asAppError(error);
    return res.status(400).json({
      error: "browse_failed",
      message: failure?.message || "Failed to browse storage path.",
    });
  }
});

router.post("/ensure", noCache, (req, res) => {
  try {
    if (!canBrowseFilesystem(req)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Admin access is required to browse storage paths.",
      });
    }
    const ensured = ensureDownloadFolderPath(req.body?.path);
    if (!ensured.valid) {
      return res.status(400).json({
        error: "ensure_failed",
        message: ensured.error || "Failed to prepare folder path.",
      });
    }
    const result = listBrowseDirectory(ensured.path);
    return res.json({
      ...result,
      path: ensured.path,
      created: !!ensured.created,
    });
  } catch (error) {
    const failure = asAppError(error);
    return res.status(400).json({
      error: "ensure_failed",
      message: failure?.message || "Failed to prepare folder path.",
    });
  }
});

export default router;
