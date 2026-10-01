import { UUID_REGEX } from "../../../../lib/uuid.js";
import {
  getMusicbrainzAppearsOnScanState,
  musicbrainzGetArtistAppearsOnReleaseGroups,
} from "../../../services/apiClients/index.js";

export function registerAppearsOn(router) {
  router.post("/:mbid/appears-on", async (req, res) => {
    const { mbid } = req.params;
    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({ error: "Invalid MBID format" });
    }

    const limit = Math.min(24, Math.max(1, Number.parseInt(req.body?.limit, 10) || 24));
    const offset = Math.min(250, Math.max(0, Number.parseInt(req.body?.offset, 10) || 0));
    const excludeIds = new Set(
      (Array.isArray(req.body?.excludeIds) ? req.body.excludeIds : [])
        .map((id) => String(id || "").trim())
        .filter((id) => UUID_REGEX.test(id)),
    );
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      let availableItems = await musicbrainzGetArtistAppearsOnReleaseGroups(mbid, {
        limit: 250,
        offset: 0,
        signal: controller.signal,
        scanPageBudget: 0,
      });
      let unseenItems = availableItems.filter((item) => !excludeIds.has(item.id));
      const cachedScanState = getMusicbrainzAppearsOnScanState(mbid);
      if (unseenItems.length < limit && !cachedScanState.complete) {
        availableItems = await musicbrainzGetArtistAppearsOnReleaseGroups(mbid, {
          limit: 250,
          offset: 0,
          signal: controller.signal,
          scanPageBudget: 1,
        });
        unseenItems = availableItems.filter((item) => !excludeIds.has(item.id));
      }
      const items = unseenItems.slice(0, limit);
      if (controller.signal.aborted) return;
      const scanState = getMusicbrainzAppearsOnScanState(mbid);
      return res.json({
        items,
        offset,
        hasMore: unseenItems.length > items.length || !scanState.complete,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return;
      return res.status(502).json({
        error: "Failed to load artist appearances",
        message: error.message,
      });
    }
  });
}
