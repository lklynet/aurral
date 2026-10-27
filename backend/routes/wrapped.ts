import express from "express";
import { requireAuth, requireUserAccount } from "../middleware/requirePermission.ts";
import {
  getWrappedReport,
  requestWrappedReport,
  validateWrappedRequest,
} from "../services/wrapped/reports.ts";
import { isWrappedEnabled } from "../config/apiContract.ts";
import { createSubsonicPlaylist } from "../services/subsonicLibraryService.ts";
import {
  getWrappedAnnouncement,
  setWrappedAnnouncementHidden,
} from "../services/wrapped/announcement.ts";
import { isWrappedPreviewBuild } from "../../lib/wrapped.ts";
import { APP_VERSION } from "../config/constants.ts";
import {
  getWrappedAvailability,
  getWrappedPreview,
  setWrappedPreview,
} from "../services/wrapped/preview.ts";

const router = express.Router();
router.post(
  "/preview",
  (_req, res, next) => (isWrappedPreviewBuild(APP_VERSION) ? next() : res.sendStatus(404)),
  requireAuth,
  requireUserAccount,
  (req, res) => {
    const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : "UTC";
    try {
      const preview = setWrappedPreview(req.user!.id, timeZone, req.body?.enabled !== false);
      const report = preview
        ? requestWrappedReport(req.user!.id, preview.year, timeZone, Date.now(), true)
        : null;
      return res.set("Cache-Control", "no-store").json({ report });
    } catch {
      return res
        .status(400)
        .json({ error: "The preview could not be started. Check the timezone and try again." });
    }
  },
);
router.use((req, res, next) =>
  isWrappedEnabled() || (req.user && req.user.id > 0 && getWrappedPreview(req.user.id))
    ? next()
    : res.sendStatus(404),
);
router.use(requireAuth, requireUserAccount);
router.get("/announcement", (req, res) => {
  const timeZone = typeof req.query.timeZone === "string" ? req.query.timeZone : "UTC";
  try {
    const season = getWrappedAvailability(req.user!.id);
    if (!season) return res.sendStatus(404);
    return res
      .set("Cache-Control", "no-store")
      .json(getWrappedAnnouncement(req.user!.id, season.year, timeZone));
  } catch {
    return res.status(400).json({ error: "Choose a valid timezone" });
  }
});
router.post("/announcement", (req, res) => {
  const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : "UTC";
  if (typeof req.body?.hidden !== "boolean")
    return res.status(400).json({ error: "Choose whether to hide the announcement" });
  try {
    return res
      .set("Cache-Control", "no-store")
      .json(
        setWrappedAnnouncementHidden(
          req.user!.id,
          Number(req.body?.year),
          timeZone,
          req.body.hidden,
        ),
      );
  } catch {
    return res.status(400).json({ error: "Choose the latest released year and a valid timezone" });
  }
});
router.get("/:year", (req, res) => {
  const year = Number(req.params.year);
  const timeZone = typeof req.query.timeZone === "string" ? req.query.timeZone : "UTC";
  try {
    validateWrappedRequest(req.user!.id, year, timeZone);
    res
      .set("Cache-Control", "no-store")
      .json({ report: getWrappedReport(req.user!.id, year, timeZone) });
  } catch {
    res.status(400).json({ error: "Choose a valid year and timezone" });
  }
});
router.post("/:year", (req, res) => {
  const year = Number(req.params.year);
  const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : "UTC";
  try {
    const report = requestWrappedReport(
      req.user!.id,
      year,
      timeZone,
      Date.now(),
      req.body?.refresh === true,
    );
    res
      .set("Cache-Control", "no-store")
      .status(report.state === "ready" ? 200 : 202)
      .json({ report });
  } catch {
    res.status(400).json({ error: "Choose the latest released year and a valid timezone" });
  }
});
router.post("/:year/playlist", async (req, res) => {
  try {
    const year = Number(req.params.year);
    const timeZone = typeof req.body?.timeZone === "string" ? req.body.timeZone : "UTC";
    validateWrappedRequest(req.user!.id, year, timeZone);
    const report = getWrappedReport(req.user!.id, year, timeZone);
    if (report?.state !== "ready") return res.status(409).json({ error: "Build your recap first" });
    const songIds = report.summary.topSongs.flatMap((song) =>
      song.libraryTrackId ? [`song:${song.libraryTrackId}`] : [],
    );
    if (!songIds.length)
      return res.status(409).json({ error: "None of these songs are available in your Library" });
    const playlist = await createSubsonicPlaylist(req.user!, {
      name: `Your ${year} Wrapped`,
      songIds,
    });
    if (!playlist)
      return res
        .status(403)
        .json({ error: "The playlist could not be created. Check your playlist permissions." });
    return res.status(201).json({
      playlistId: playlist.id,
      trackCount: songIds.length,
      unavailableCount: report.summary.topSongs.length - songIds.length,
    });
  } catch {
    return res
      .status(400)
      .json({ error: "The playlist could not be saved. Rebuild your recap and try again." });
  }
});
export type WrappedResponse = { report: ReturnType<typeof getWrappedReport> };
export type WrappedAnnouncementResponse = ReturnType<typeof getWrappedAnnouncement>;
export type WrappedPlaylistResponse = {
  playlistId: string;
  trackCount: number;
  unavailableCount: number;
};
export default router;
