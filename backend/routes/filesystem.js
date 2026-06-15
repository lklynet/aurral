import express from "express";
import { dbOps } from "../config/db-helpers.js";
import { noCache } from "../middleware/cache.js";
import { resolveRequestUser } from "../middleware/auth.js";
import {
  ensureDownloadFolderPath,
  listBrowseDirectory,
} from "../services/downloadFolderConfig.js";

const router = express.Router();

function canBrowseFilesystem(req) {
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
    return res.status(400).json({
      error: "browse_failed",
      message: error?.message || "Failed to browse storage path.",
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
    return res.status(400).json({
      error: "ensure_failed",
      message: error?.message || "Failed to prepare folder path.",
    });
  }
});

export default router;
