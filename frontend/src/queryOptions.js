import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./queryClient.js";
import { getEditorialPlaylist, getEditorialShelf } from "./utils/api/endpoints/discovery.js";
import { getReleaseGroupDetails } from "./utils/api/endpoints/artists.js";
import {
  getPlaylistJobs,
  getPlaylistStatus,
  getPlaylistTrackStreamUrl,
} from "./utils/api/endpoints/playlists.js";

export const editorialShelfQueryOptions = (userId) =>
  queryOptions({
    queryKey: queryKeys.editorialShelf(userId),
    queryFn: ({ signal }) => getEditorialShelf({ signal }),
    staleTime: 60 * 60 * 1000,
  });

export const editorialPlaylistQueryOptions = (userId, playlistId) =>
  queryOptions({
    queryKey: queryKeys.editorialPlaylist(userId, playlistId),
    queryFn: ({ signal }) => getEditorialPlaylist(playlistId, { signal }),
    staleTime: 5 * 60 * 1000,
  });

export const releaseGroupDetailsQueryOptions = (releaseMbid) =>
  queryOptions({
    queryKey: queryKeys.releaseGroupDetails(releaseMbid),
    queryFn: ({ signal }) => getReleaseGroupDetails(releaseMbid, { signal }),
    enabled: Boolean(releaseMbid),
    staleTime: 5 * 60 * 1000,
  });

export const playlistStatusQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.playlistStatus,
    queryFn: ({ signal }) => getPlaylistStatus({ signal, bypassCache: true }),
    staleTime: 4_000,
  });

const normalizePlaylistJobs = (jobs) =>
  (Array.isArray(jobs) ? jobs : []).map((job) => ({
    ...job,
    albumName: job?.albumName || null,
    reason: job?.reason || null,
    streamUrl: job?.status === "done" && job?.id ? getPlaylistTrackStreamUrl(job.id) : null,
  }));

export const playlistJobsQueryOptions = (playlistId) =>
  queryOptions({
    queryKey: queryKeys.playlistJobs(playlistId),
    queryFn: ({ signal }) => getPlaylistJobs(playlistId, null, { signal }).then(normalizePlaylistJobs),
    enabled: Boolean(playlistId),
    staleTime: 15_000,
  });
