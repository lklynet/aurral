import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { queryKeys } from "./queryClient.ts";
import { artistsClient } from "./utils/api/clients/artists.ts";
import { discoveryClient } from "./utils/api/clients/discovery.ts";
import { normalizeDiscoveryData } from "./pages/discoverUtils.ts";
import { playlistJobsClient } from "./utils/api/clients/playlistJobs.ts";
import {
  getPlaylistTrackStreamUrl,
  withAuthenticatedTrackArtwork,
} from "./utils/api/playlistUrls.ts";

type MaybeId = string | number | null | undefined;
type MaybeText = string | null | undefined;

export const discoveryQueryOptions = (userId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.discovery(userId),
    queryFn: async ({ signal }) =>
      normalizeDiscoveryData(
        await parseResponse(discoveryClient.$get({ query: {} }, { init: { signal } })),
      ),
    staleTime: 30_000,
  });

export const editorialShelfQueryOptions = (userId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.editorialShelf(userId),
    queryFn: ({ signal }) =>
      parseResponse(discoveryClient.editorial.$get(undefined, { init: { signal } })),
    staleTime: 60 * 60 * 1000,
  });

export const editorialPlaylistQueryOptions = (userId: MaybeId, playlistId: string) =>
  queryOptions({
    queryKey: queryKeys.editorialPlaylist(userId, playlistId),
    queryFn: ({ signal }) =>
      parseResponse(
        discoveryClient.editorial[":playlistId"].$get(
          { param: { playlistId: encodeURIComponent(playlistId) } },
          { init: { signal } },
        ),
      ),
    staleTime: 5 * 60 * 1000,
  });

export const trendingChartsQueryOptions = (userId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.trendingCharts(userId),
    queryFn: ({ signal }) =>
      parseResponse(discoveryClient.trending.$get(undefined, { init: { signal } })),
    staleTime: 30 * 60 * 1000,
  });

export const trendingGenreQueryOptions = (genreId: string) =>
  queryOptions({
    queryKey: queryKeys.trendingGenre(genreId),
    queryFn: ({ signal }) =>
      parseResponse(
        discoveryClient.trending.genres[":genreId"].$get(
          { param: { genreId: encodeURIComponent(genreId) } },
          { init: { signal } },
        ),
      ),
    staleTime: 30 * 60 * 1000,
  });

export const releaseGroupDetailsQueryOptions = (releaseMbid: MaybeText) =>
  queryOptions({
    queryKey: queryKeys.releaseGroupDetails(releaseMbid),
    queryFn: ({ signal }) =>
      parseResponse(
        artistsClient["release-group"][":mbid"].$get(
          { param: { mbid: encodeURIComponent(releaseMbid ?? "") } },
          { init: { signal } },
        ),
      ),
    enabled: Boolean(releaseMbid),
    staleTime: 5 * 60 * 1000,
  });

export const playlistStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.playlistStatus,
    queryFn: ({ signal }) =>
      parseResponse(playlistJobsClient.status.$get(undefined, { init: { signal } })),
    staleTime: 4_000,
  });

export const playlistJobsQueryOptions = (playlistId: MaybeText) =>
  queryOptions({
    queryKey: queryKeys.playlistJobs(playlistId),
    queryFn: ({ signal }) =>
      parseResponse(
        playlistJobsClient.jobs[":playlistId"].$get(
          { param: { playlistId: encodeURIComponent(playlistId ?? "") }, query: {} },
          { init: { signal } },
        ),
      ).then((jobs) =>
        jobs.map((job) => ({
          ...withAuthenticatedTrackArtwork(job),
          albumName: job.albumName || null,
          reason: job.reason || null,
          streamUrl: job.status === "done" && job.id ? getPlaylistTrackStreamUrl(job.id) : null,
        })),
      ),
    enabled: Boolean(playlistId),
    staleTime: 15_000,
  });
