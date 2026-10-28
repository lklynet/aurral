import { Hono } from "hono";
import * as v from "valibot";
import { UUID_REGEX } from "../../../../lib/uuid.ts";
import { dbOps } from "../../../db/helpers/index.ts";
import { noCache } from "../../../middleware/cacheHeaders.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import { buildImageProxyUrl } from "../../../services/imageProxyService.ts";
import { fetchReleaseGroupCoverUrl } from "../../../services/releaseGroupCoverService.ts";
import { getFreshReleasesByArtists } from "../../../services/discovery/freshReleases.ts";
import { getUserDiscovery } from "../../../services/discovery/userDiscovery.ts";
import { libraryManager } from "../../../services/libraryManager.ts";
import { normalizePercentOfTracks } from "../../../services/lidarrAlbumStats.ts";
import { logger } from "../../../services/logger.ts";
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

type ReadAlbum = ReturnType<typeof getLibraryReadModelForAlbumReferences>["albums"][number];
type ReadTrack = ReturnType<typeof getLibraryReadModelForAlbumReferences>["tracks"][number];
type ReadArtist = ReturnType<typeof getLibraryReadModelForArtists>["artists"][number];
type ManagedTrack = Awaited<ReturnType<typeof libraryManager.getTracks>>[number];
type LidarrArtist = Parameters<typeof libraryManager.mapLidarrArtist>[0];

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
  canonicalInLibrary: true,
  canonicalAlbumId: String(album.canonicalId ?? album.id),
  canonicalArtistId: String(album.artistId),
  libraryAlbumId: String(album.providerId ?? album.id),
  libraryArtistId: String(album.providerArtistId ?? album.artistId),
  status:
    album.trackListComplete === false ||
    Number(album.statistics?.trackCount || 0) > Number(album.statistics?.trackFileCount || 0)
      ? "partial"
      : album.available
        ? "available"
        : "partial",
  monitored: album.monitored,
  managedBy: album.managedBy || null,
  trackListComplete: album.trackListComplete !== false,
  ...(album.trackListComplete === false
    ? {}
    : { percentOfTracks: Number(album.statistics?.percentOfTracks || 0) }),
  sizeOnDisk: Number(album.statistics?.sizeOnDisk || 0),
  trackCount: Number(album.statistics?.trackCount || 0),
  trackFileCount: Number(album.statistics?.trackFileCount || 0),
  ownedTrackMbids,
  albumName: String(album.albumName || album.title || "").trim(),
  releaseDate: String(album.releaseDate || "").trim(),
});

const ownedLidarrTrackMbids = (tracks: WithAbsentKeys<ManagedTrack, "foreignTrackId">[]) =>
  (Array.isArray(tracks) ? tracks : [])
    .filter((track) => track?.hasFile === true || track?.path)
    .map((track) => track?.mbid || track?.foreignTrackId)
    .map((mbid) => String(mbid || "").trim())
    .filter(Boolean);

type WithAbsentKeys<Value, Keys extends PropertyKey> = Value extends unknown
  ? Value & { [Key in Exclude<Keys, keyof Value>]?: undefined }
  : never;

const toLibraryArtist = (
  artist: WithAbsentKeys<
    | ReturnType<typeof getLibraryArtistProjection>[number]
    | ReadArtist
    | ReturnType<typeof libraryManager.mapLidarrArtist>,
    "providerId" | "canonicalId"
  >,
) => ({
  ...artist,
  id: artist.providerId ?? artist.id,
  canonicalId: String(artist.canonicalId ?? artist.id),
  foreignArtistId: artist.foreignArtistId || artist.mbid,
  added: artist.addedAt,
});

const toLibraryAlbum = (
  album: WithAbsentKeys<
    ReadAlbum | ReturnType<typeof libraryManager.mapLidarrAlbum>,
    "providerId" | "canonicalId" | "providerArtistId"
  >,
) => ({
  ...album,
  id: album.providerId ?? album.id,
  artistId: album.providerArtistId ?? album.artistId,
  canonicalId: String(album.canonicalId ?? album.id),
  foreignAlbumId: album.foreignAlbumId || album.mbid,
  title: album.albumName,
  albumType: "Album",
});

export async function getArtistLibraryLookup(mbid: string) {
  const { artists, albums } = getLibraryReadModelForArtists({
    source: "all",
    availableOnly: false,
    mbids: [mbid],
    includeSharedAlbums: true,
  });
  const artist = artists.find((candidate) => candidate.mbid === mbid);
  const libraryArtistId = artist ? String(artist.canonicalId ?? artist.id) : null;
  const aurralArtist = getLibraryArtistProjection({ reference: mbid }).find(
    (candidate) => candidate.mbid === mbid && candidate.managedBy === "aurral",
  );
  if (aurralArtist) {
    return {
      exists: true,
      artist: toLibraryArtist(aurralArtist),
      albums: albums.map(toLibraryAlbum),
      canonical: true,
      libraryArtistId,
    };
  }
  const { lidarrClient } = await import("../../../services/lidarrClient.ts");
  const lidarrConfigured = lidarrClient.isConfigured();
  let lidarrArtist: LidarrArtist | null | undefined;
  let lidarrAlbums;
  if (lidarrConfigured) {
    try {
      lidarrArtist = await lidarrClient.getArtistByMbid(mbid, { forceRefresh: true });
      if (lidarrArtist) {
        const albums = await lidarrClient.request(
          `/album?artistId=${encodeURIComponent(lidarrArtist.id)}`,
          "GET",
          null,
          false,
          { forceRefresh: true },
        );
        if (!Array.isArray(albums)) throw new Error("Invalid Lidarr album response");
        lidarrAlbums = albums.map((album) =>
          toLibraryAlbum(libraryManager.mapLidarrAlbum(album, lidarrArtist!)),
        );
      }
    } catch {
      lidarrArtist = undefined;
      lidarrAlbums = undefined;
    }
  }
  if (lidarrArtist && lidarrAlbums) {
    return {
      exists: true,
      artist: toLibraryArtist(libraryManager.mapLidarrArtist(lidarrArtist)),
      albums: lidarrAlbums,
      canonical: true,
      libraryArtistId,
    };
  }
  if (lidarrArtist === undefined && artist && (!lidarrConfigured || artist.lidarrManaged)) {
    return {
      exists: true,
      artist: toLibraryArtist(artist),
      albums: albums.map(toLibraryAlbum),
      canonical: true,
      libraryArtistId,
    };
  }
  return {
    exists: false,
    artist: null,
    albums: [],
    canonical: true,
    libraryArtistId,
  };
}

type LidarrAlbumLookupResult = {
  inLibrary: true;
  canonicalInLibrary: false;
  libraryAlbumId: string | null;
  libraryArtistId: string | null;
  managedBy?: undefined;
  status: "available" | "monitored" | "unmonitored";
  monitored: boolean;
  trackListComplete: true;
  percentOfTracks: number;
  sizeOnDisk: number;
  trackCount: number;
  trackFileCount: number;
  ownedTrackMbids: ReturnType<typeof ownedLidarrTrackMbids>;
  albumName: string;
  releaseDate: string;
};

const mbidsInput = v.object({ mbids: v.optional(v.array(v.nullable(v.string()))) });

const uniqueMbids = (mbids: (string | null)[]) => [
  ...new Set(mbids.map((mbid) => String(mbid || "").trim()).filter(Boolean)),
];

export default new Hono<AppEnv>()
  .basePath("/library")
  .get("/rootfolder", async (c) => {
    try {
      const { lidarrClient } = await import("../../../services/lidarrClient.ts");
      const configured = lidarrClient.getConfiguredRootFolderPaths();
      if (!lidarrClient.isEnabled())
        return c.json(
          configured.map((path) => ({ path })),
          200,
        );
      if (!lidarrClient.isConfigured() && configured.length === 0) return c.json([], 200);
      const rootFolders = await lidarrClient.getRootFolders();
      return c.json(
        Array.isArray(rootFolders) ? rootFolders.map((folder) => ({ path: folder.path })) : [],
        200,
      );
    } catch (error) {
      return c.json(
        { error: "Failed to fetch root folder", message: asAppError(error)?.message },
        500,
      );
    }
  })
  .get("/lookup/:mbid", async (c) => {
    try {
      const mbid = c.req.param("mbid");
      if (!UUID_REGEX.test(mbid)) return c.json({ error: "Invalid MBID format" }, 400);
      return c.json(await getArtistLibraryLookup(mbid), 200);
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
      const results: Record<
        string,
        ReturnType<typeof libraryAlbumResult> | LidarrAlbumLookupResult
      > = {};
      if (wanted.length === 0) return c.json(results, 200);
      const { lidarrClient, LIDARR_ALBUM_LOOKUP_BATCH_MAX } =
        await import("../../../services/lidarrClient.ts");
      if (wanted.length > LIDARR_ALBUM_LOOKUP_BATCH_MAX) {
        return c.json(
          { error: `mbids must contain at most ${LIDARR_ALBUM_LOOKUP_BATCH_MAX} unique values` },
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

      if (!lidarrClient.isConfigured()) return c.json(results, 200);
      const albums = await lidarrClient.getAlbumsByMbidsSettled(wanted, { forceRefresh: true });

      for (let index = 0; index < wanted.length; index += 1) {
        const foreignAlbumId = wanted[index];
        const result = albums[index];
        if (result.status === "rejected") {
          logger.warn("library", "Lidarr album lookup failed", {
            foreignAlbumId,
            message: result.reason?.message || String(result.reason),
          });
          continue;
        }
        const album = result.value;
        if (!album) {
          if (results[foreignAlbumId]?.managedBy !== "aurral") delete results[foreignAlbumId];
          continue;
        }
        if (results[foreignAlbumId]) continue;

        const albumTracks = album.id ? await libraryManager.getTracks(album.id) : [];

        const percentOfTracks = normalizePercentOfTracks(album?.statistics?.percentOfTracks);
        const sizeOnDisk = Number(album?.statistics?.sizeOnDisk || 0);
        const trackCount = Number(album?.statistics?.trackCount || 0);
        const trackFileCount = Number(album?.statistics?.trackFileCount || 0);
        const hasFiles = sizeOnDisk > 0 || trackFileCount > 0;
        const monitored = Boolean(album?.monitored);

        results[foreignAlbumId] = {
          inLibrary: true,
          canonicalInLibrary: false,
          libraryAlbumId: album.id !== undefined && album.id !== null ? String(album.id) : null,
          libraryArtistId:
            album.artistId !== undefined && album.artistId !== null ? String(album.artistId) : null,
          status: hasFiles ? "available" : monitored ? "monitored" : "unmonitored",
          monitored,
          trackListComplete: true,
          percentOfTracks,
          sizeOnDisk,
          trackCount,
          trackFileCount,
          ownedTrackMbids: ownedLidarrTrackMbids(albumTracks),
          albumName: String(album?.title || "").trim(),
          releaseDate: String(album?.releaseDate || "").trim(),
        };
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
      const recent = getRecentlyAddedLibraryArtists({ availableOnly: true, limit: 20 }).map(
        (artist) => ({
          ...artist,
          foreignArtistId: artist.foreignArtistId || artist.mbid,
          added: artist.addedAt,
        }),
      );
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
        coverTargets.map(async (album) => {
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
        warmedVisibleCovers.filter(([coverId, coverUrl]) => coverId && coverUrl),
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
