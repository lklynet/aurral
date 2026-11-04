import { Hono } from "hono";
import * as v from "valibot";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { selectCanonicalFile } from "../../../services/canonicalFileSelector.ts";
import { getLibraryForTrackIds } from "../../../services/libraryQueryService.ts";
import { buildRadio } from "../../../services/radio.ts";
import { buildPublicLibrary } from "./libraryIndex.ts";

const refs = v.optional(v.pipe(v.array(v.string()), v.maxLength(500)));

const radioInput = v.object({
  trackIds: refs,
  albumIds: refs,
  artists: v.optional(
    v.pipe(
      v.array(
        v.object({
          id: v.nullish(v.string()),
          mbid: v.nullish(v.string()),
          name: v.nullish(v.string()),
        }),
      ),
      v.maxLength(50),
    ),
  ),
  exclude: v.optional(v.pipe(v.array(v.string()), v.maxLength(2000))),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
});

function toRadioTracks(trackIds: number[]) {
  const library = buildPublicLibrary(getLibraryForTrackIds({ ids: trackIds, availableOnly: true }));
  const artists = new Map(library.artists.map((artist) => [artist.id, artist]));
  const albums = new Map(library.albums.map((album) => [album.id, album]));
  const tracks = new Map(library.tracks.map((track) => [track.id, track]));
  return trackIds.flatMap((trackId) => {
    const track = tracks.get(trackId);
    const playable = (track?.albums ?? []).flatMap(({ albumId }) => {
      const album = albums.get(albumId);
      const file = album && selectCanonicalFile(track?.files, album.id, album.managedBy ?? null);
      return album && file?.available ? [{ album, file }] : [];
    });
    const [first] = playable;
    if (!track || !first) return [];
    const { album, file } = first;
    const artist = artists.get(album.artistId);
    const artworkUrl = "artworkUrl" in track ? track.artworkUrl : null;
    return [
      {
        id: String(track.id),
        title: track.title || "Unknown Track",
        artist: track.artistName || artist?.name || "Unknown Artist",
        album: album.title || "Unknown Album",
        streamPath: `/library/canonical-stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`,
        streamFormat: file.format || null,
        quality: file.quality?.quality?.name || file.quality?.audioFormat || null,
        durationMs: file.durationMs ?? null,
        artistMbid: artist?.mbid ?? null,
        albumMbid: album.releaseGroupMbid || album.mbid || null,
        trackMbid: track.mbid ?? null,
        libraryTrackId: track.id,
        libraryAlbumId: album.id,
        artworkUrl: artworkUrl || album.coverUrl,
        artworkSource: artworkUrl ? "track" : "album",
      },
    ];
  });
}

export default new Hono<AppEnv>()
  .basePath("/library")
  .post("/radio", requireAuth, noCache, validate("json", radioInput), async (c) => {
    const { exclude, limit, ...seed } = c.req.valid("json");
    const userId = c.var.user.id > 0 ? c.var.user.id : null;
    const trackIds = await buildRadio({ userId, seed, exclude, limit });
    return c.json({ tracks: toRadioTracks(trackIds) }, 200);
  });
