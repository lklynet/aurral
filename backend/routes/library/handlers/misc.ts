import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { buildImageProxyUrl } from "../../../services/imageProxyService.ts";
import {
  buildLibraryArtworkUrl,
  getLibraryArtworkVersions,
} from "../../../services/libraryArtwork.ts";
import { fetchReleaseGroupCoverUrl } from "../../../services/releaseGroupCoverService.ts";
import { getFreshReleasesByArtists } from "../../../services/discovery/freshReleases.ts";
import { getUserDiscovery } from "../../../services/discovery/userDiscovery.ts";
import {
  getLibraryReadModelForAlbumReferences,
  getLibraryReadModelForArtists,
} from "../../../services/libraryReadModel.ts";
import {
  getLibraryArtistMbids,
  getLibraryArtistProjection,
  getRecentlyAddedLibraryArtists,
} from "../../../services/libraryQueryService.ts";
import { asAppError } from "../../../../lib/errors.ts";

const ARTIST_LOOKUP_BATCH_MAX = 100;
const ALBUM_LOOKUP_BATCH_MAX = 100;

type ReadAlbum = ReturnType<typeof getLibraryReadModelForAlbumReferences>["albums"][number];
type ReadTrack = ReturnType<typeof getLibraryReadModelForAlbumReferences>["tracks"][number];
type ReadArtist = ReturnType<typeof getLibraryReadModelForArtists>["artists"][number];

const libraryAlbumLookup = (albums: ReadAlbum[], reference: string) => {
  const value = String(reference || "").trim();
  if (!value) return undefined;
  return albums.find((album) =>
    [album.foreignAlbumId, album.mbid, album.releaseGroupMbid, album.identityKey].some(
      (candidate) => String(candidate || "").trim() === value,
    ),
  );
};

const libraryAlbumResult = (album: ReadAlbum, ownedTrackMbids: string[] = []) => ({
  inLibrary: true,
  fromLibraryIndex: true,
  libraryAlbumId: String(album.id),
  libraryArtistId: String(album.artistId),
  status:
    album.trackListComplete === false ||
    Number(album.statistics?.trackCount || 0) > Number(album.statistics?.trackFileCount || 0)
      ? "partial"
      : album.available
        ? "available"
        : "partial",
  monitored: album.monitored,
  managed: Boolean(album.managed),
  trackListComplete: album.trackListComplete !== false,
  ...(album.trackListComplete !== false && {
    percentOfTracks: Number(album.statistics?.percentOfTracks || 0),
  }),
  sizeOnDisk: Number(album.statistics?.sizeOnDisk || 0),
  trackCount: Number(album.statistics?.trackCount || 0),
  trackFileCount: Number(album.statistics?.trackFileCount || 0),
  ownedTrackMbids,
  albumName: String(album.albumName || album.title || "").trim(),
  releaseDate: String(album.releaseDate || "").trim(),
});

type WithAbsentKeys<Value, Keys extends PropertyKey> = Value extends unknown
  ? Value & { [Key in Exclude<Keys, keyof Value>]?: undefined }
  : never;

const toLibraryArtist = (
  artist: WithAbsentKeys<
    ReturnType<typeof getLibraryArtistProjection>[number] | ReadArtist,
    "providerId"
  >,
  libraryId?: string | number,
) => ({
  ...artist,
  id: artist.providerId ?? artist.id,
  ...(libraryId != null && { libraryId: String(libraryId) }),
  foreignArtistId: artist.foreignArtistId || artist.mbid,
  added: artist.addedAt,
});

const toLibraryAlbum = (album: ReadAlbum, libraryId?: string | number) => ({
  ...album,
  id: album.providerId ?? album.id,
  artistId: album.providerArtistId ?? album.artistId,
  ...(libraryId != null && { libraryId: String(libraryId) }),
  foreignAlbumId: album.foreignAlbumId || album.mbid,
  title: album.albumName,
  albumType: "Album",
});

const ownedLibraryAlbums = (albums: ReadAlbum[]) => {
  const owned = albums.filter((album) => album.statistics.trackFileCount > 0);
  const versions = getLibraryArtworkVersions(
    "album",
    owned.map((album) => album.id),
  );
  return owned.map((album) => ({
    libraryId: String(album.id),
    releaseGroupMbid: album.releaseGroupMbid,
    title: album.title,
    releaseDate: album.releaseDate,
    partial:
      album.trackListComplete === false ||
      album.statistics.trackCount > album.statistics.trackFileCount,
    coverUrl: buildLibraryArtworkUrl("album", album.id, versions.get(String(album.id))),
  }));
};

export function getArtistLibraryLookup(mbid: string) {
  const { artists, albums } = getLibraryReadModelForArtists({
    source: "all",
    availableOnly: false,
    mbids: [mbid],
    includeSharedAlbums: true,
  });
  const artist = artists.find((candidate) => candidate.mbid === mbid);
  const libraryArtistId = artist ? String(artist.id) : null;
  const ownedAlbums = ownedLibraryAlbums(albums);
  const found =
    getLibraryArtistProjection({ reference: mbid }).find(
      (candidate) => candidate.mbid === mbid && candidate.managed,
    ) ?? artist;
  if (found) {
    return {
      exists: true,
      artist: toLibraryArtist(found, found.id),
      albums: albums.map((album) => toLibraryAlbum(album, album.id)),
      fromLibraryIndex: true,
      libraryArtistId,
      ownedAlbums,
    };
  }
  return {
    exists: false,
    artist: null,
    albums: [],
    fromLibraryIndex: true,
    libraryArtistId,
    ownedAlbums,
  };
}

const mbidsInput = v.object({ mbids: v.optional(v.array(v.nullable(v.string()))) });

const uniqueMbids = (mbids: (string | null)[]) => [
  ...new Set(mbids.map((mbid) => String(mbid || "").trim()).filter(Boolean)),
];

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/lookup/:mbid", async (c) => {
    try {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
      return c.json(getArtistLibraryLookup(mbid), 200);
    } catch (error) {
      return c.json({ error: "Failed to lookup artist", message: asAppError(error)?.message }, 500);
    }
  })
  .post("/lookup/batch", validate("json", mbidsInput), (c) => {
    try {
      const { mbids } = c.req.valid("json");
      if (!mbids) return c.json({ error: "mbids must be an array" }, 400);
      const wanted = uniqueMbids(mbids);
      if (wanted.length > ARTIST_LOOKUP_BATCH_MAX) {
        return c.json(
          { error: `mbids must contain at most ${ARTIST_LOOKUP_BATCH_MAX} unique values` },
          400,
        );
      }
      const existingArtistIds = getLibraryArtistMbids({
        source: "all",
        availableOnly: false,
        mbids: wanted,
      });
      const results: Record<string, boolean> = {};
      for (const mbid of wanted) {
        results[mbid] = existingArtistIds.has(mbid);
      }
      return c.json(results, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to batch lookup artists", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .post("/albums/lookup/batch", validate("json", mbidsInput), async (c) => {
    try {
      const { mbids } = c.req.valid("json");
      if (!mbids) return c.json({ error: "mbids must be an array" }, 400);
      const wanted = uniqueMbids(mbids);
      const results: Record<string, ReturnType<typeof libraryAlbumResult>> = {};
      if (wanted.length === 0) return c.json(results, 200);
      if (wanted.length > ALBUM_LOOKUP_BATCH_MAX) {
        return c.json(
          { error: `mbids must contain at most ${ALBUM_LOOKUP_BATCH_MAX} unique values` },
          400,
        );
      }
      const { albums: libraryAlbums, tracks: libraryTracks } =
        getLibraryReadModelForAlbumReferences({
          source: "all",
          availableOnly: false,
          references: wanted,
        });
      const tracksByAlbumId = new Map<string, ReadTrack[]>();
      for (const track of libraryTracks) {
        const albumTracks = tracksByAlbumId.get(String(track.albumId)) || [];
        albumTracks.push(track);
        tracksByAlbumId.set(String(track.albumId), albumTracks);
      }
      for (const foreignAlbumId of wanted) {
        const album = libraryAlbumLookup(libraryAlbums, foreignAlbumId);
        if (album) {
          const albumTracks = tracksByAlbumId.get(String(album.id)) || [];
          const trackCount = albumTracks.length;
          const trackFileCount = albumTracks.filter((track) => track.available).length;
          results[foreignAlbumId] = libraryAlbumResult(
            {
              ...album,
              available: trackFileCount > 0,
              statistics: {
                ...album.statistics,
                trackCount,
                trackFileCount,
                percentOfTracks: trackCount > 0 ? (trackFileCount / trackCount) * 100 : 0,
              },
            },
            albumTracks
              .filter((track) => track.available && track.mbid)
              .map((track) => String(track.mbid).trim())
              .filter(Boolean),
          );
        }
      }

      return c.json(results, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to batch lookup albums", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/recent", noCache, (c) => {
    try {
      const artists = getRecentlyAddedLibraryArtists({ availableOnly: true, limit: 20 });
      const versions = getLibraryArtworkVersions(
        "artist",
        artists.map((artist) => artist.id),
      );
      const recent = artists.map((artist) => ({
        ...artist,
        foreignArtistId: artist.foreignArtistId || artist.mbid,
        added: artist.addedAt,
        coverUrl: buildLibraryArtworkUrl("artist", artist.id, versions.get(artist.id)),
      }));
      return c.json(recent, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to fetch recent artists", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/recent-releases", async (c) => {
    try {
      const { getRecentMissingReleases } =
        await import("../../../services/discovery/recentReleases.ts");
      const fromLibrary = await getRecentMissingReleases(24);
      const libraryReleaseIds = new Set(fromLibrary.map((album) => album.mbid));
      const fromRecommendations = getFreshReleasesByArtists(
        getUserDiscovery(c.var.user?.id ?? null, 0).body.recommendations.map((artist) => artist.id),
      ).filter((album) => !libraryReleaseIds.has(album.mbid));
      const recentMissing = [...fromLibrary, ...fromRecommendations]
        .sort((left, right) => right.releaseDate.localeCompare(left.releaseDate))
        .slice(0, 24);

      const cachedCovers = dbOps.getImages(
        recentMissing
          .map((album) => album.mbid || album.foreignAlbumId)
          .filter(Boolean)
          .map((id) => `rg:${id}`),
      );

      const coverTargets = recentMissing
        .filter((album) => libraryReleaseIds.has(album.mbid))
        .slice(0, 6);
      const warmedVisibleCovers = await Promise.all(
        coverTargets.map(async (album): Promise<[string | null, string | null]> => {
          const coverId = album.mbid || album.foreignAlbumId;
          if (!coverId) return [null, null];

          const cachedUrl = cachedCovers[`rg:${coverId}`]?.imageUrl || null;
          if (cachedUrl && cachedUrl !== "NOT_FOUND") {
            const imageUrl = buildImageProxyUrl(cachedUrl);
            if (imageUrl) return [coverId, imageUrl];
          }

          const cover = await fetchReleaseGroupCoverUrl(coverId, {
            artistName: album.artistName || "",
            albumTitle: album.albumName || "",
          }).catch(() => null);

          if (!cover?.imageUrl) {
            return [coverId, null];
          }

          return [coverId, buildImageProxyUrl(cover.imageUrl)];
        }),
      );

      const warmedCoverMap = Object.fromEntries(
        warmedVisibleCovers.filter((entry): entry is [string, string] =>
          Boolean(entry[0] && entry[1]),
        ),
      );

      const withCachedCovers = recentMissing.map((album) => {
        const coverId = album.mbid || album.foreignAlbumId;
        const cachedUrl = coverId ? cachedCovers[`rg:${coverId}`]?.imageUrl || null : null;
        const coverUrl =
          (coverId ? warmedCoverMap[coverId] : null) ||
          (cachedUrl && cachedUrl !== "NOT_FOUND" ? buildImageProxyUrl(cachedUrl) : null);
        return {
          ...album,
          coverUrl,
        };
      });

      c.header("Cache-Control", "private, no-store");
      return c.json(withCachedCovers, 200);
    } catch (error) {
      return c.json(
        { error: "Failed to fetch recent releases", message: asAppError(error)?.message },
        500,
      );
    }
  });
