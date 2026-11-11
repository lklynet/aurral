import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { db } from "../../../config/db-sqlite.ts";
import type { LibraryAlbumsRow, LibraryArtistsRow } from "../../../db/rows.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import { requireAuth, requirePermission } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { selectBestArtistImage } from "../../../services/imageRanking.ts";
import {
  setLibraryAlbumReleaseGroup,
  setLibraryArtistMbid,
} from "../../../services/libraryMediaStore.ts";
import {
  getAlbumByMbid,
  getArtistByMbid,
  isMetadataNotFoundError,
  listArtistAlbums,
  searchAlbums,
  searchArtists,
} from "../../../services/providers/brainzmashProvider.ts";
import { attachCachedCoverUrls } from "../../../services/releaseGroupCoverService.ts";

const MATCH_LIMIT = 12;
const providerUnavailable = { error: "Could not reach the metadata provider. Try again." };

const matchQuery = v.object({ q: v.optional(v.pipe(v.string(), v.trim())) });
const mbidInput = v.object({ mbid: v.optional(v.nullable(v.string())) });

const readMbid = (raw: string | null | undefined) =>
  typeof raw === "string" ? raw.trim().toLowerCase() : null;

const libraryIdsByMbid = (
  table: "library_artists" | "library_albums",
  column: "mbid" | "release_group_mbid",
  ids: string[],
) =>
  new Map(
    ids.length
      ? db
          .prepare<string[], { id: number; mbid: string }>(
            `SELECT id, ${column} AS mbid FROM ${table} WHERE ${column} IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids)
          .map((row) => [row.mbid, row.id])
      : [],
  );

async function artistMatches(artist: LibraryArtistsRow, query: string) {
  const { items } = await searchArtists(query || artist.name, {
    limit: MATCH_LIMIT,
    throwOnFailure: true,
  });
  const inLibrary = libraryIdsByMbid(
    "library_artists",
    "mbid",
    items.map((item) => item.id),
  );
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    disambiguation: item.disambiguation || null,
    type: item.type || null,
    imageUrl: selectBestArtistImage(item.images)?.url || null,
    libraryArtistId: inLibrary.get(item.id) ?? null,
  }));
}

async function albumMatches(
  album: LibraryAlbumsRow & { artist_name: string; artist_mbid: string | null },
  query: string,
) {
  const candidates = album.artist_mbid
    ? attachCachedCoverUrls(await listArtistAlbums(album.artist_mbid, { hydrateLimit: 0 })).map(
        (entry) => ({
          ...entry,
          releaseDate: null,
          coverUrl:
            "coverUrl" in entry && typeof entry.coverUrl === "string" ? entry.coverUrl : null,
        }),
      )
    : (
        await searchAlbums(query || album.title, {
          artistName: album.artist_name,
          limit: MATCH_LIMIT,
          throwOnFailure: true,
          musicbrainzFallback: false,
        })
      ).items;
  const inLibrary = libraryIdsByMbid(
    "library_albums",
    "release_group_mbid",
    candidates.map((entry) => entry.id).filter((id): id is string => Boolean(id)),
  );
  return {
    source: album.artist_mbid ? ("discography" as const) : ("search" as const),
    items: candidates.flatMap((entry) =>
      entry.id
        ? [
            {
              id: entry.id,
              title: entry.title || "Untitled",
              type: entry.type || "Album",
              secondaryTypes: (entry.secondaryTypes ?? []).filter(
                (type): type is string => typeof type === "string",
              ),
              year: entry.releaseDate?.slice(0, 4) || null,
              coverUrl: entry.coverUrl,
              libraryAlbumId: inLibrary.get(entry.id) ?? null,
            },
          ]
        : [],
    ),
  };
}

export default new Hono<AppEnv>()
  .basePath("/library")
  .get(
    "/artists/:id/matches",
    noCache,
    requireAuth,
    requirePermission("addArtist"),
    validate("query", matchQuery),
    async (c) => {
      const artist = db
        .prepare<[number], LibraryArtistsRow>("SELECT * FROM library_artists WHERE id = ?")
        .get(Number(c.req.param("id")));
      if (!artist) return c.json({ error: "Artist not found" }, 404);
      try {
        return c.json({ items: await artistMatches(artist, c.req.valid("query").q ?? "") }, 200);
      } catch {
        return c.json(providerUnavailable, 503);
      }
    },
  )
  .put(
    "/artists/:id/mbid",
    requireAuth,
    requirePermission("addArtist"),
    validate("json", mbidInput),
    async (c) => {
      const artistId = Number(c.req.param("id"));
      const mbid = readMbid(c.req.valid("json").mbid);
      if (!Number.isSafeInteger(artistId) || (mbid !== null && !UUID_REGEX.test(mbid))) {
        return c.json({ error: "A MusicBrainz artist ID or null is required" }, 400);
      }
      let musicbrainzName = null;
      if (mbid) {
        try {
          musicbrainzName = (await getArtistByMbid(mbid)).name || null;
        } catch (error) {
          if (isMetadataNotFoundError(error)) {
            return c.json({ error: "MusicBrainz has no artist with that ID" }, 404);
          }
          return c.json(providerUnavailable, 503);
        }
      }
      const result = setLibraryArtistMbid(artistId, mbid);
      const { artist } = result;
      if (!artist) return c.json({ error: "Artist not found" }, 404);
      return c.json(
        {
          id: artist.id,
          mbid: artist.mbid,
          name: artist.name,
          musicbrainzName,
          merged: Boolean(result.mergedArtistId),
        },
        200,
      );
    },
  )
  .get(
    "/albums/:id/matches",
    noCache,
    requireAuth,
    requirePermission("addAlbum"),
    validate("query", matchQuery),
    async (c) => {
      const album = db
        .prepare<[number], LibraryAlbumsRow & { artist_name: string; artist_mbid: string | null }>(
          `SELECT album.*, artist.name AS artist_name, artist.mbid AS artist_mbid
           FROM library_albums AS album
           JOIN library_artists AS artist ON artist.id = album.artist_id
           WHERE album.id = ?`,
        )
        .get(Number(c.req.param("id")));
      if (!album) return c.json({ error: "Album not found" }, 404);
      try {
        return c.json(await albumMatches(album, c.req.valid("query").q ?? ""), 200);
      } catch (error) {
        if (isMetadataNotFoundError(error)) return c.json({ source: "search", items: [] }, 200);
        return c.json(providerUnavailable, 503);
      }
    },
  )
  .put(
    "/albums/:id/release-group",
    requireAuth,
    requirePermission("addAlbum"),
    validate("json", mbidInput),
    async (c) => {
      const albumId = Number(c.req.param("id"));
      const mbid = readMbid(c.req.valid("json").mbid);
      if (!Number.isSafeInteger(albumId) || (mbid !== null && !UUID_REGEX.test(mbid))) {
        return c.json({ error: "A MusicBrainz release group ID or null is required" }, 400);
      }
      let musicbrainzTitle = null;
      if (mbid) {
        try {
          musicbrainzTitle = (await getAlbumByMbid(mbid)).title || null;
        } catch (error) {
          if (isMetadataNotFoundError(error)) {
            return c.json({ error: "MusicBrainz has no release group with that ID" }, 404);
          }
          return c.json(providerUnavailable, 503);
        }
      }
      const result = setLibraryAlbumReleaseGroup(albumId, mbid);
      if (!result.album) {
        if (result.error === "tagged") {
          return c.json(
            {
              error:
                "This album's files are tagged with a MusicBrainz release. Retag them to change the match.",
            },
            409,
          );
        }
        return c.json({ error: "Album not found" }, 404);
      }
      return c.json(
        {
          id: result.album.id,
          title: result.album.title,
          releaseGroupMbid: result.album.release_group_mbid,
          musicbrainzTitle,
          merged: result.merged,
        },
        200,
      );
    },
  );
