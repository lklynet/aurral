import { queryOptions } from "@tanstack/react-query";
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
type ReleaseGroupPreview = InferResponseType<
  (typeof artistsClient)["release-group"][":mbid"]["previews"]["$get"],
  200
>["previews"][string];
export type ReleaseGroupTrack = InferResponseType<
  (typeof artistsClient)["release-group"][":mbid"]["tracks"]["$get"],
  200
>[number] &
  Partial<ReleaseGroupPreview>;
export type SimilarArtistsResponse = InferResponseType<
  (typeof artistsClient)[":mbid"]["similar"]["$get"],
  200
>;
type ReleaseGroupRatings = InferResponseType<
  (typeof artistsClient)["release-groups"]["ratings"]["$post"],
  200
>;
type ReleaseGroupCoverResponse = InferResponseType<
  (typeof artistsClient)["release-group"][":mbid"]["cover"]["$get"],
  200
>;
type ArtistVideo = NonNullable<
  InferResponseType<(typeof artistsClient)[":mbid"]["video"]["$get"], 200>["video"]
> & { trackTitle: string };

const coverFetch = apiFetchWithin(4000);

export const getReleaseTrackCredits = (mbid: string, { signal }: { signal?: AbortSignal } = {}) =>
  parseResponse(
    artistsClient.release[":mbid"].credits.$get(
      { param: { mbid: encodeURIComponent(mbid) } },
      { init: { signal } },
    ),
  );

export const getReleaseGroupTracks = (
  mbid: string,
  { release, signal }: { release?: string; signal?: AbortSignal } = {},
) =>
  parseResponse(
    artistsClient["release-group"][":mbid"].tracks.$get(
      { param: { mbid: encodeURIComponent(mbid) }, query: { release: release || undefined } },
      { init: { signal } },
    ),
  );

export type AlbumEditions = InferResponseType<
  (typeof artistsClient)["release-group"][":mbid"]["editions"]["$get"],
  200
>;

export const getReleaseGroupEditions = (mbid: string, { signal }: { signal?: AbortSignal } = {}) =>
  parseResponse(
    artistsClient["release-group"][":mbid"].editions.$get(
      { param: { mbid: encodeURIComponent(mbid) } },
      { init: { signal } },
    ),
  );

export const getReleaseGroupPreviews = (
  mbid: string,
  {
    signal,
    artistMbid,
    deezerAlbumId,
    release,
  }: { artistMbid?: string; deezerAlbumId?: string; release?: string; signal?: AbortSignal } = {},
) =>
  parseResponse(
    artistsClient["release-group"][":mbid"].previews.$get(
      {
        param: { mbid: encodeURIComponent(mbid) },
        query: {
          artistMbid: artistMbid || undefined,
          deezerAlbumId: deezerAlbumId || undefined,
          release: release || undefined,
        },
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

const normalizeCoverPart = (value: string | null | undefined) =>
  String(value || "")
    .trim()
    .toLowerCase();

const releaseGroupCoverCacheKey = (
  mbid: string,
  artistName: string | null | undefined = "",
  albumTitle: string | null | undefined = "",
) => `release-group:${mbid}:${normalizeCoverPart(artistName)}:${normalizeCoverPart(albumTitle)}`;

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

export const artistSimilarQueryOptions = (mbid: string, artistName = "", limit = 20) =>
  queryOptions({
    queryKey: queryKeys.artistSimilar(mbid, artistName, limit),
    queryFn: ({ signal }) =>
      parseResponse(
        artistsClient[":mbid"].similar.$get(
          {
            param: { mbid: encodeURIComponent(mbid) },
            query: { limit: String(limit), artistName: artistName.trim() || undefined },
          },
          { init: { signal, cache: "no-cache" } },
        ),
      ),
    staleTime: 5 * 60 * 1000,
  });

export const artistPlaylistsQueryOptions = (mbid: string, artistName: string) =>
  queryOptions({
    queryKey: queryKeys.artistPlaylists(mbid, artistName),
    queryFn: ({ signal }) =>
      parseResponse(
        artistsClient[":mbid"].playlists.$get(
          {
            param: { mbid: encodeURIComponent(mbid) },
            query: { artistName: artistName.trim() || undefined },
          },
          { init: { signal } },
        ),
      ),
    staleTime: 60 * 60 * 1000,
  });

export const artistShowsQueryOptions = (mbid: string, artistName: string) =>
  queryOptions({
    queryKey: queryKeys.artistShows(mbid, artistName),
    queryFn: ({ signal }) =>
      parseResponse(
        artistsClient[":mbid"].shows.$get(
          {
            param: { mbid: encodeURIComponent(mbid) },
            query: { artistName: artistName.trim() || undefined },
          },
          { init: { signal } },
        ),
      ),
    staleTime: 60 * 60 * 1000,
  });

export const artistListeningQueryOptions = (mbid: string, artistName: string) =>
  queryOptions({
    queryKey: queryKeys.artistListening(mbid, artistName),
    queryFn: ({ signal }) =>
      parseResponse(
        artistsClient[":mbid"].listening.$get(
          {
            param: { mbid: encodeURIComponent(mbid) },
            query: { artistName: artistName.trim() || undefined },
          },
          { init: { signal } },
        ),
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
  await queryClient.invalidateQueries({ queryKey: queryKeys.artistAppearsOn(mbid) });
  await queryClient.invalidateQueries({ queryKey: queryKeys.artistPlaylistsPrefix });
  return result;
};
