import { queryOptions, skipToken } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { queryKeys } from "./queryClient.ts";
import { artistsClient } from "./utils/api/clients/artists.ts";
import { discoveryClient } from "./utils/api/clients/discovery.ts";
import type { BrowseProvider } from "../../lib/browsePlaylists.ts";
import type { ShelfScope } from "../../backend/services/importLists/deezerPlaylists.ts";
import { normalizeDiscoveryData } from "./pages/discoverUtils.ts";
import { playlistJobsClient } from "./utils/api/clients/playlistJobs.ts";
import { pluginsClient } from "./utils/api/clients/plugins.ts";
import { settingsClient } from "./utils/api/clients/settings.ts";
import { usersClient } from "./utils/api/clients/users.ts";
import { lookupAlbumsInLibraryBatch } from "./utils/api/endpoints/library.ts";
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

export const pluginImportListsQueryOptions = (enabled: boolean) =>
  queryOptions({
    queryKey: queryKeys.pluginImportLists,
    queryFn: ({ signal }) =>
      parseResponse(pluginsClient["import-lists"].$get({}, { init: { signal } })),
    enabled,
  });

export const listeningHistoryQueryOptions = (userId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.listeningHistory(userId),
    queryFn: ({ signal }) =>
      parseResponse(usersClient.me["listening-history"].$get({}, { init: { signal } })),
    enabled: userId != null,
    staleTime: 30_000,
  });

export const spotifyHistoryQueryOptions = (userId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.spotifyHistory(userId),
    queryFn: async ({ signal }) =>
      (await parseResponse(discoveryClient["spotify-import"].$get({}, { init: { signal } })))
        .summary,
    enabled: userId != null,
    staleTime: 30_000,
  });

export const lidarrPreferencesQueryOptions = (userId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.lidarrPreferences(userId),
    queryFn: ({ signal }) =>
      parseResponse(usersClient.me["lidarr-preferences"].$get({}, { init: { signal } })),
    enabled: userId != null,
    staleTime: 30_000,
  });

export const appSettingsQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.appSettings,
    queryFn: ({ signal }) => parseResponse(settingsClient.$get({}, { init: { signal } })),
    staleTime: 30_000,
  });

export const playlistShelfQueryOptions = (userId: MaybeId, scope: ShelfScope = "all") =>
  queryOptions({
    queryKey: queryKeys.playlistShelf(userId, scope),
    queryFn: ({ signal }) =>
      parseResponse(discoveryClient.playlists.$get({ query: { scope } }, { init: { signal } })),
    staleTime: 60 * 60 * 1000,
  });

export const madeForYouQueryOptions = (userId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.madeForYou(userId),
    queryFn: ({ signal }) =>
      parseResponse(
        discoveryClient.playlists["made-for-you"].$get(undefined, { init: { signal } }),
      ),
    staleTime: 10 * 60 * 1000,
  });

export const browsePlaylistQueryOptions = (
  userId: MaybeId,
  provider: BrowseProvider,
  playlistId: string,
) =>
  queryOptions({
    queryKey: queryKeys.browsePlaylist(userId, provider, playlistId),
    queryFn: ({ signal }) =>
      parseResponse(
        discoveryClient.playlists[":provider"][":playlistId"].$get(
          { param: { provider, playlistId: encodeURIComponent(playlistId) } },
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

export const libraryAlbumLookupQueryOptions = (releaseGroupMbid: MaybeText) =>
  queryOptions({
    queryKey: queryKeys.libraryAlbumLookup(releaseGroupMbid ? [releaseGroupMbid] : []),
    queryFn: ({ signal }) =>
      lookupAlbumsInLibraryBatch([releaseGroupMbid], { signal, bypassCache: true }),
    enabled: Boolean(releaseGroupMbid),
    staleTime: 15_000,
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

type ContainingTrack = Parameters<typeof playlistJobsClient.containing.$get>[0]["query"];

export const playlistsContainingQueryOptions = (track: ContainingTrack | null) =>
  queryOptions({
    queryKey: queryKeys.playlistsContaining(track),
    queryFn: track
      ? ({ signal }) =>
          parseResponse(
            playlistJobsClient.containing.$get({ query: track }, { init: { signal } }),
          ).then((result) => new Map(result.playlists.map((entry) => [entry.id, entry.jobId])))
      : skipToken,
    staleTime: 0,
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
          streamUrl:
            (job.status === "done" || job.status === "saved") && job.id
              ? getPlaylistTrackStreamUrl(job.id)
              : null,
        })),
      ),
    enabled: Boolean(playlistId),
    staleTime: 15_000,
  });
