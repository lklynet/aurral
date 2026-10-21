import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { noCache } from "../../../middleware/cache.ts";
import {
  requireAdmin,
  requireAuth,
  requirePermission,
} from "../../../middleware/requirePermission.ts";
import { removeMonitoringExclusion } from "../../../services/aurralMonitoringStore.ts";
import { libraryManager } from "../../../services/libraryManager.ts";

const sendResult = (res, result, successStatus = 200) => {
  if (result?.error) {
    const { error, statusCode, ...details } = result;
    return res.status(statusCode || 500).json({ ...details, error, message: error });
  }
  return res.status(successStatus).json(result);
};

const sendFailure = (res, error, message) =>
  res.status(500).json({ error: message, message: error?.message || message });

export type PreviewArtistMonitoringResponse = Extract<
  Awaited<ReturnType<typeof libraryManager.previewAurralArtistMonitoring>>,
  { monitoring: unknown }
>;

export type GetMonitoringDefaultsResponse = ReturnType<
  typeof libraryManager.getMonitoringDefaultsState
>;

export type PreviewMonitoringDefaultsResponse = Awaited<
  ReturnType<typeof libraryManager.previewMonitoringDefaults>
>;

export type SaveMonitoringDefaultsResponse = ReturnType<
  typeof libraryManager.setMonitoringDefaults
>;

export type GetMonitoringExclusionsResponse = ReturnType<
  typeof libraryManager.listMonitoringExclusions
>;

export type RemoveMonitoringExclusionResponse = { success: true };

export function registerMonitoring(router) {
  router.post(
    "/artists/:mbid/monitoring/preview",
    requireAuth,
    requirePermission("changeMonitoring"),
    async (req, res) => {
      if (!UUID_REGEX.test(req.params.mbid)) {
        return res.status(400).json({ error: "Invalid MBID format" });
      }
      try {
        sendResult(
          res,
          await libraryManager.previewAurralArtistMonitoring(req.params.mbid, {
            monitoring: req.body?.monitoring,
            artistName: req.body?.artistName,
          }),
        );
      } catch (error) {
        sendFailure(res, error, "Failed to preview artist monitoring");
      }
    },
  );

  router.get("/monitoring/defaults", requireAuth, noCache, (_req, res) => {
    try {
      res.json(libraryManager.getMonitoringDefaultsState());
    } catch (error) {
      sendFailure(res, error, "Failed to read monitoring defaults");
    }
  });

  router.post("/monitoring/defaults/preview", requireAuth, requireAdmin, async (req, res) => {
    try {
      sendResult(res, await libraryManager.previewMonitoringDefaults(req.body?.rules));
    } catch (error) {
      sendFailure(res, error, "Failed to preview monitoring defaults");
    }
  });

  router.put("/monitoring/defaults", requireAuth, requireAdmin, (req, res) => {
    try {
      sendResult(res, libraryManager.setMonitoringDefaults(req.body?.rules));
    } catch (error) {
      sendFailure(res, error, "Failed to save monitoring defaults");
    }
  });

  router.get("/monitoring/exclusions", requireAuth, noCache, (req, res) => {
    const artistMbid = String(req.query.artistMbid || "").trim();
    if (artistMbid && !UUID_REGEX.test(artistMbid)) {
      return res.status(400).json({ error: "Invalid MBID format" });
    }
    try {
      res.json(libraryManager.listMonitoringExclusions({ artistMbid: artistMbid || null }));
    } catch (error) {
      sendFailure(res, error, "Failed to read monitoring exclusions");
    }
  });

  router.delete(
    "/monitoring/exclusions/:id",
    requireAuth,
    requirePermission("changeMonitoring"),
    (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ error: "id must be a positive integer" });
      }
      try {
        if (!removeMonitoringExclusion(id))
          return res.status(404).json({ error: "Exclusion not found" });
        res.json({ success: true });
      } catch (error) {
        sendFailure(res, error, "Failed to remove the exclusion");
      }
    },
  );
}
