import { parseResponse, type InferResponseType } from "hono/client";
import {
  apiFetchWithin,
  fetchCoverWithMemo,
  getCoverCacheEntry,
  setCoverCacheEntry,
  coverInflightRequests,
} from "../core.ts";
import { artistsClient } from "../clients/artists.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";

export type ArtistDetailsResponse = InferResponseType<(typeof artistsClient)[":mbid"]["$get"], 200>;
export type ReleaseGroupTrack = InferResponseType<
  (typeof artistsClient)["release-group"][":mbid"]["tracks"]["$get"],
  200
>[number];
export type SimilarArtistsResponse = InferResponseType<
  (typeof artistsClient)[":mbid"]["similar"]["$get"],
  200
>;
type ReleaseGroupRatings = InferResponseType<
  (typeof artistsClient)["release-groups"]["ratings"]["$post"],
  200
>;
type ReleaseGroupCoverEntry = InferResponseType<
  (typeof artistsClient)["release-groups"]["covers"]["$post"],
  200
>["covers"][string];
type ReleaseGroupCoverResponse = InferResponseType<
  (typeof artistsClient)["release-group"][":mbid"]["cover"]["$get"],
  200
>;
type ArtistVideo = NonNullable<
  InferResponseType<(typeof artistsClient)[":mbid"]["video"]["$get"], 200>["video"]
> & { trackTitle: string };

type ArtistDetailsOptions = {
  mode?: string;
  releaseTypes?: string[];
  appearsOnLimit?: number;
};

type ReleaseGroupCoverItem = { mbid: string; artistName: string; albumTitle: string };

const coverFetch = apiFetchWithin(4000);

export const getArtistDetails = (
  mbid: string,
  artistName?: string,
  options: ArtistDetailsOptions = {},
) =>
  queryClient.fetchQuery({
    queryKey: queryKeys.artistDetails(mbid, { artistName, ...options }),
    queryFn: ({ signal }) =>
      parseResponse(
        artistsClient[":mbid"].$get(
          {
            param: { mbid: encodeURIComponent(mbid) },
            query: {
              artistName: artistName || undefined,
              mode: options.mode || undefined,
              releaseTypes: options.releaseTypes?.length
                ? options.releaseTypes.join(",")
                : undefined,
              appearsOnLimit:
                Number.isFinite(Number(options.appearsOnLimit)) &&
                Number(options.appearsOnLimit) > 0
                  ? String(Number.parseInt(String(options.appearsOnLimit), 10))
                  : undefined,
            },
          },
          { init: { signal } },
        ),
      ),
    staleTime: 60_000,
  });

export const getReleaseGroupTracks = (
  mbid: string,
  {
    signal,
    deezerAlbumId,
    ...context
  }: {
    artistMbid?: string;
    artistName?: string;
    albumTitle?: string;
    releaseType?: string;
    releaseDate?: string;
    deezerAlbumId?: string | number;
    signal?: AbortSignal;
  } = {},
) =>
  parseResponse(
    artistsClient["release-group"][":mbid"].tracks.$get(
      {
        param: { mbid: encodeURIComponent(mbid) },
        query: { ...context, deezerAlbumId: deezerAlbumId ? String(deezerAlbumId) : undefined },
      },
      { init: { signal } },
    ),
  );

export const getArtistPreview = (
  mbid: string | number,
  artistName?: string | null,
  { signal }: { signal?: AbortSignal } = {},
) =>
  parseResponse(
    artistsClient[":mbid"].preview.$get(
      { param: { mbid: encodeURIComponent(mbid) }, query: { artistName: artistName || undefined } },
      { init: { signal } },
    ),
  );

export const getReleaseGroupRatingsBatch = async (
  ids: string[] = [],
): Promise<ReleaseGroupRatings> => {
  const normalizedIds = [...new Set(ids.filter(Boolean))];
  if (!normalizedIds.length) return { ratings: {} };
  return queryClient.fetchQuery({
    queryKey: queryKeys.releaseGroupRatings(normalizedIds),
    queryFn: () =>
      parseResponse(
        artistsClient["release-groups"].ratings.$post({ json: { ids: normalizedIds } }),
      ),
    staleTime: 5 * 60 * 1000,
  });
};

const RELEASE_GROUP_COVER_BATCH_SIZE = 24;

const normalizeCoverPart = (value: string | null | undefined) =>
  String(value || "")
    .trim()
    .toLowerCase();

const releaseGroupCoverCacheKey = (
  mbid: string,
  artistName: string | null | undefined = "",
  albumTitle: string | null | undefined = "",
) => `release-group:${mbid}:${normalizeCoverPart(artistName)}:${normalizeCoverPart(albumTitle)}`;

const releaseGroupBatchCoverCacheKey = (
  mbid: string,
  artistName: string | null | undefined = "",
  albumTitle: string | null | undefined = "",
) =>
  `release-group-batch:${mbid}:${normalizeCoverPart(artistName)}:${normalizeCoverPart(albumTitle)}`;

export const getArtistCover = async (
  mbid: string | number,
  artistName?: string | null,
  refresh = false,
) => {
  const trimmedName = typeof artistName === "string" ? artistName.trim() : "";
  return fetchCoverWithMemo(
    `artist:${mbid}`,
    () =>
      parseResponse(
        artistsClient[":mbid"].cover.$get(
          {
            param: { mbid: encodeURIComponent(mbid) },
            query: {
              artistName: trimmedName || undefined,
              refresh: refresh ? "true" : undefined,
            },
          },
          { fetch: coverFetch },
        ),
      ),
    { bypassCache: refresh },
  );
};

export const getReleaseGroupCoversBatch = async (
  items: {
    mbid?: string | null;
    id?: string;
    artistName?: string | null;
    albumTitle?: string | null;
  }[] = [],
): Promise<Record<string, ReleaseGroupCoverEntry>> => {
  const normalizedItems = items
    .map((item) => ({
      mbid: String(item?.mbid || item?.id || "").trim(),
      artistName: typeof item?.artistName === "string" ? item.artistName.trim() : "",
      albumTitle: typeof item?.albumTitle === "string" ? item.albumTitle.trim() : "",
    }))
    .filter((item) => item.mbid);
  if (!normalizedItems.length) {
    return {};
  }
  const covers: Record<string, ReleaseGroupCoverEntry> = {};
  const uncachedItems: ReleaseGroupCoverItem[] = [];
  normalizedItems.forEach((item) => {
    const cached = getCoverCacheEntry<ReleaseGroupCoverEntry>(
      releaseGroupBatchCoverCacheKey(item.mbid, item.artistName, item.albumTitle),
    );
    if (cached) covers[item.mbid] = cached;
    else uncachedItems.push(item);
  });
  if (!uncachedItems.length) return covers;
  const batchKey = normalizedItems
    .map((item) => `${item.mbid}:${item.artistName.toLowerCase()}:${item.albumTitle.toLowerCase()}`)
    .sort()
    .join("\0");
  if (coverInflightRequests.has(batchKey)) {
    return coverInflightRequests.get(batchKey) as Promise<Record<string, ReleaseGroupCoverEntry>>;
  }
  const request = (async () => {
    for (let index = 0; index < uncachedItems.length; index += RELEASE_GROUP_COVER_BATCH_SIZE) {
      const batch = uncachedItems.slice(index, index + RELEASE_GROUP_COVER_BATCH_SIZE);
      const { covers: batchCovers } = await parseResponse(
        artistsClient["release-groups"].covers.$post({ json: { items: batch } }),
      );
      Object.assign(covers, batchCovers);
      Object.entries(batchCovers).forEach(([mbid, cover]) => {
        const item = batch.find((candidate) => candidate.mbid === mbid);
        if (item && !cover?.transientError) {
          setCoverCacheEntry(
            releaseGroupBatchCoverCacheKey(mbid, item.artistName, item.albumTitle),
            cover,
          );
        }
      });
    }
    return covers;
  })().finally(() => {
    coverInflightRequests.delete(batchKey);
  });
  coverInflightRequests.set(batchKey, request);
  return request;
};

export const getReleaseGroupCover = async (
  mbid: string,
  {
    artistName = "",
    albumTitle = "",
    bypassCache = false,
  }: { artistName?: string; albumTitle?: string; bypassCache?: boolean } = {},
): Promise<ReleaseGroupCoverResponse> => {
  const cacheKey = releaseGroupCoverCacheKey(mbid, artistName, albumTitle);
  const refreshKey = `${cacheKey}:refresh`;
  if (!bypassCache) {
    const refresh = coverInflightRequests.get(refreshKey);
    if (refresh) return refresh as Promise<ReleaseGroupCoverResponse>;
    const cached = getCoverCacheEntry<ReleaseGroupCoverResponse>(cacheKey);
    if (cached) {
      return cached;
    }
  } else {
    const normal = coverInflightRequests.get(cacheKey);
    if (normal) await normal.catch(() => undefined);
  }
  const inflightKey = bypassCache ? refreshKey : cacheKey;
  if (coverInflightRequests.has(inflightKey)) {
    return coverInflightRequests.get(inflightKey) as Promise<ReleaseGroupCoverResponse>;
  }
  const request = (async () => {
    const data = await parseResponse(
      artistsClient["release-group"][":mbid"].cover.$get({
        param: { mbid: encodeURIComponent(mbid) },
        query: {
          artistName: artistName.trim() || undefined,
          albumTitle: albumTitle.trim() || undefined,
          refresh: bypassCache ? "true" : undefined,
        },
      }),
    );
    if (!data?.transientError) {
      setCoverCacheEntry(cacheKey, data);
    }
    return data;
  })().finally(() => {
    coverInflightRequests.delete(inflightKey);
  });
  coverInflightRequests.set(inflightKey, request);
  return request;
};

export const getSimilarArtistsForArtist = (mbid: string, artistName = "", limit = 20) =>
  queryClient.fetchQuery({
    queryKey: queryKeys.artistSimilar(mbid, artistName, limit),
    queryFn: () =>
      parseResponse(
        artistsClient[":mbid"].similar.$get({
          param: { mbid: encodeURIComponent(mbid) },
          query: { limit: String(limit), artistName: artistName.trim() || undefined },
        }),
      ),
    staleTime: 5 * 60 * 1000,
  });

export async function getArtistVideos(
  mbid: string,
  artistName: string,
  tracks: { title: string }[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ videos: ArtistVideo[]; failed: boolean }> {
  const popularTracks = tracks.slice(0, 6);
  const videos: ArtistVideo[] = [];
  const seen = new Set<string>();
  let failed = false;
  for (let index = 0; index < popularTracks.length && videos.length < 3;) {
    signal?.throwIfAborted();
    const batch = popularTracks.slice(index, index + 3 - videos.length);
    index += batch.length;
    const results = await Promise.all(
      batch.map(async (track) => {
        try {
          const data = await parseResponse(
            artistsClient[":mbid"].video.$get(
              {
                param: { mbid: encodeURIComponent(mbid) },
                query: { artistName, trackTitle: track.title },
              },
              { init: { signal } },
            ),
          );
          return data?.video ? { ...data.video, trackTitle: track.title } : null;
        } catch {
          signal?.throwIfAborted();
          failed = true;
          return null;
        }
      }),
    );
    signal?.throwIfAborted();
    for (const video of results) {
      if (!video?.videoId || seen.has(video.videoId)) continue;
      seen.add(video.videoId);
      videos.push(video);
    }
  }
  return { videos, failed };
}

export const updateArtistOverrides = async (
  mbid: string,
  {
    musicbrainzId = null,
    deezerArtistId = null,
  }: { musicbrainzId?: string | null; deezerArtistId?: string | null } = {},
) => {
  const result = await parseResponse(
    artistsClient[":mbid"].overrides.$put({
      param: { mbid: encodeURIComponent(mbid) },
      json: { musicbrainzId, deezerArtistId },
    }),
  );
  queryClient.setQueryData(queryKeys.artistOverrides(mbid), result);
  await queryClient.invalidateQueries({ queryKey: queryKeys.artistDetailsPrefix });
  await queryClient.invalidateQueries({ queryKey: queryKeys.artistSimilarPrefix });
  return result;
};
