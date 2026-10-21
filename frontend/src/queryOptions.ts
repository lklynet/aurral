import { queryOptions } from "@tanstack/react-query";
import { queryKeys } from "./queryClient.ts";
import { getEditorialPlaylist, getEditorialShelf } from "./utils/api/endpoints/discovery.ts";
import { getReleaseGroupDetails } from "./utils/api/endpoints/artists.ts";
import {
  getPlaylistJobs,
  getPlaylistStatus,
  getPlaylistTrackStreamUrl,
} from "./utils/api/endpoints/playlists.ts";

type MaybeId = string | number | null | undefined;
type MaybeText = string | null | undefined;
type PlaylistJob = {
  id?: string | number;
  status?: string;
  albumName?: string | null;
  reason?: string | null;
};

export const editorialShelfQueryOptions = (userId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.editorialShelf(userId),
    queryFn: ({ signal }) => getEditorialShelf({ signal }),
    staleTime: 60 * 60 * 1000,
  });

export const editorialPlaylistQueryOptions = (userId: MaybeId, playlistId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.editorialPlaylist(userId, playlistId),
    queryFn: ({ signal }) => getEditorialPlaylist(playlistId, { signal }),
    staleTime: 5 * 60 * 1000,
  });

export const releaseGroupDetailsQueryOptions = (releaseMbid: MaybeText) =>
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

const normalizePlaylistJobs = (jobs: PlaylistJob[]) =>
  (Array.isArray(jobs) ? jobs : []).map((job) => ({
    ...job,
    albumName: job?.albumName || null,
    reason: job?.reason || null,
    streamUrl: job?.status === "done" && job?.id ? getPlaylistTrackStreamUrl(job.id) : null,
  }));

export const playlistJobsQueryOptions = (playlistId: MaybeId) =>
  queryOptions({
    queryKey: queryKeys.playlistJobs(playlistId),
    queryFn: ({ signal }) =>
      getPlaylistJobs(playlistId, null, { signal }).then(normalizePlaylistJobs),
    enabled: Boolean(playlistId),
    staleTime: 15_000,
  });
