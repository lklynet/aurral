import { requireAuth, requirePermission } from "../../../middleware/requirePermission.js";
import { requireAppCapability } from "../../../middleware/appProfile.js";
import { handleDiscoverAdoptError } from "./utils.js";

export function registerAdopt(router) {
  router.post(
    "/playlists/adopt",
    requireAppCapability("flows"),
    requireAuth,
    requirePermission("accessFlow"),
    async (req, res) => {
      try {
        const presetId = String(req.body?.presetId || "").trim();
        if (!presetId) {
          return res.status(400).json({ error: "presetId is required" });
        }

        const { adoptDiscoverPresetAsFlow } =
          await import("../../../services/discovery/playlistAdopt.js");
        const result = await adoptDiscoverPresetAsFlow(req.user, presetId);
        res.json(result);
      } catch (error) {
        handleDiscoverAdoptError(
          res,
          error,
          "Failed to adopt discover playlist",
        );
      }
    },
  );

  router.post(
    "/playlists/adopt-playlist",
    requireAppCapability("flows"),
    requireAuth,
    requirePermission("accessFlow"),
    async (req, res) => {
      try {
        const presetId = String(req.body?.presetId || "").trim();
        if (!presetId) {
          return res.status(400).json({ error: "presetId is required" });
        }

        const { adoptDiscoverPresetAsPlaylist } =
          await import("../../../services/discovery/playlistAdopt.js");
        const result = await adoptDiscoverPresetAsPlaylist(req.user, presetId);
        res.json(result);
      } catch (error) {
        handleDiscoverAdoptError(
          res,
          error,
          "Failed to adopt discover playlist",
        );
      }
    },
  );
}
