import { Hono, type Context } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  enqueueImportedPlaylist,
  importListFor,
  requireImportList,
  type ImportedPlaylist,
} from "../../../services/importLists/importPlaylist.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { getErrorStatus } from "../../shared/errorStatus.ts";
import { importSettings, requirePlaylistAccess } from "./utils.ts";
import lastfmImport from "./lastfmImport.ts";
import listenbrainzImport from "./listenbrainzImport.ts";
import spotifyImport from "./spotifyImport.ts";

const reference = {
  provider: v.string(),
  externalId: v.pipe(v.string(), v.trim(), v.nonEmpty("externalId is required")),
  externalUsername: v.nullish(v.string()),
};

const skippedCount = ({ stats }: ImportedPlaylist) =>
  (["unavailable", "podcast", "incomplete", "duplicate"] as const).reduce(
    (sum, key) => sum + Number(stats[key] || 0),
    0,
  );

function importFailed<E extends AppEnv>(
  c: Context<E>,
  error: unknown,
  details: {
    provider: string;
    action: "preview" | "import";
    stage?: string;
    playlistName?: string;
  },
) {
  const failure = asAppError(error);
  const status = getErrorStatus(error);
  const label = importListFor(details.provider)?.label;
  logger[status >= 500 ? "error" : "warn"]("playlist-import", `Playlist ${details.action} failed`, {
    ...details,
    reason: safeLogDiagnostic(error),
  });
  return c.json(
    {
      error: `Failed to ${details.action} ${label ? `${label} ` : ""}playlist`,
      message: failure?.message || "Unknown error",
      ...(failure?.code && { code: failure.code }),
    },
    status,
  );
}

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .post(
    "/import/preview",
    requirePlaylistAccess,
    validate("json", v.object(reference)),
    async (c) => {
      const { provider, ...rest } = c.req.valid("json");
      try {
        const playlist = await requireImportList(provider).fetch({
          userId: c.var.user.id,
          ...rest,
        });
        return c.json(
          {
            playlist: { id: playlist.id, name: playlist.name ?? null },
            trackCount: playlist.tracks.length,
            skipped: skippedCount(playlist),
            previewTracks: playlist.tracks.slice(0, 3),
          },
          200,
        );
      } catch (error) {
        return importFailed(c, error, { provider, action: "preview" });
      }
    },
  )
  .post(
    "/import",
    requirePlaylistAccess,
    validate(
      "json",
      v.object({ ...reference, ...importSettings, externalName: v.nullish(v.string()) }),
    ),
    async (c) => {
      const { provider, externalId, externalUsername, ...body } = c.req.valid("json");
      const requestedInterval = Number(body.syncIntervalHours ?? 24);
      if (!Number.isFinite(requestedInterval) || requestedInterval < 0)
        return c.json({ error: "syncIntervalHours must be zero or greater" }, 400);
      let stage = "fetch";
      try {
        const list = requireImportList(provider);
        const playlist = await list.fetch({ userId: c.var.user.id, externalId, externalUsername });
        const name = body.name.trim() || playlist.name || "";
        if (!name) return c.json({ error: "name is required" }, 400);
        const syncIntervalHours = list.sync ? requestedInterval : 0;
        stage = "enqueue";
        const result = await enqueueImportedPlaylist({
          ownerUserId: c.var.user.id,
          name,
          sourceName: list.label,
          provider,
          externalId: playlist.id,
          externalUsername: playlist.externalUsername ?? externalUsername,
          externalName: String(playlist.name || body.externalName || "").trim(),
          tracks: playlist.tracks,
          sourceStats: playlist.stats,
          artworkUrl: playlist.artworkUrl,
          syncEnabled: body.syncEnabled === false ? false : syncIntervalHours > 0,
          syncIntervalHours,
          keepRemovedTracks: body.keepRemovedTracks !== false,
        });
        return c.json(
          {
            success: true,
            tracksQueued: Number(result?.tracksQueued || 0),
            queued: result?.queued === true,
          },
          200,
        );
      } catch (error) {
        return importFailed(c, error, {
          provider,
          action: "import",
          stage,
          playlistName: body.name.trim() || undefined,
        });
      }
    },
  )
  .route("/", spotifyImport)
  .route("/", listenbrainzImport)
  .route("/", lastfmImport);
