import type { Router } from "express";
import {
  getPlaybackDestinationSettings,
  testPlaybackDestination,
} from "../../../services/playback/playbackDestinationSettings.ts";
import { asAppError } from "../../../../lib/errors.ts";

export function registerPlayback(router: Router) {
  router.get("/playback", (_req, res) => {
    res.json({ destinations: getPlaybackDestinationSettings() });
  });

  router.post("/playback/:key/test", async (req, res) => {
    try {
      const result = await testPlaybackDestination(req.params.key, req.body || {});
      if (!result.ok) {
        return res.status(400).json({ error: result.error.message, ...result.error });
      }
      return res.json({ success: true });
    } catch (error) {
      return res
        .status(400)
        .json({ error: "Connection failed", message: asAppError(error)?.message });
    }
  });
}
