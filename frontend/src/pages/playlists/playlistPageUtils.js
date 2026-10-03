import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Circle, CircleDot, Square, SquareCheck } from "lucide-react";
import {
  getPlaylistArtworkUrl,
  getPlaylistJobs,
  getPlaylistTrackStreamUrl,
} from "../../utils/api/endpoints/playlists.js";
import { queryClient, queryKeys } from "../../queryClient.js";
import {
  buildStaticTracklistPayload,
  downloadTracklistFile,
  formatNextRun,
  slugifyFilePart,
} from "./flowPageUtils";
import { getPlaylistRunActivity } from "./playlistRunActivity";
import lastfmLogo from "../../../images/logos/last-fm-color.svg";
import listenbrainzLogo from "../../../images/logos/listenbrainz-color.svg";
import spotifyLogo from "../../../images/logos/spotify-color.svg";
import youtubeMusicLogo from "../../../images/logos/youtube-music-color.svg";
import deezerLogo from "../../../images/logos/deezer-color.svg";
import { formatTrackCountLabel, isEditorialFlow } from "./playlistStats";

export const SYNCABLE_IMPORT_PROVIDERS = new Set([
  "spotify-playlist",
  "listenbrainz-playlist",
  "listenbrainz-createdfor",
  "lastfm-station",
  "youtube-music-playlist",
  "deezer-playlist",
]);

export const SYNC_INTERVAL_OPTIONS = [
  { value: 0, label: "None" },
  { value: 6, label: "Every 6 hours" },
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every 24 hours" },
  { value: 72, label: "Every 3 days" },
];

export function getImportedProviderLogo(provider) {
  if (String(provider || "").startsWith("listenbrainz-")) return listenbrainzLogo;
  if (provider === "lastfm-station") return lastfmLogo;
  if (provider === "youtube-music-playlist") return youtubeMusicLogo;
  if (provider === "deezer-playlist") return deezerLogo;
  if (provider === "spotify-playlist") return spotifyLogo;
  return null;
}

export function getImportedProviderLabel(provider) {
  if (String(provider || "").startsWith("listenbrainz-")) return "ListenBrainz";
  if (provider === "lastfm-station") return "Last.fm";
  if (provider === "youtube-music-playlist") return "YouTube Music";
  if (provider === "deezer-playlist") return "Deezer";
  return "Spotify";
}

export const optionMenuItem = ({ checked, ...item }) => ({
  ...item,
  checked,
  icon: checked ? SquareCheck : Square,
});

export const choiceMenuItem = ({ checked, ...item }) => ({
  ...item,
  checked,
  icon: checked ? CircleDot : Circle,
});

export const formatTrackTotal = (count) => `${count} ${count === 1 ? "track" : "tracks"}`;

export const formatFlowTrackLabel = (count, stats) =>
  Number(stats?.total || 0) > 0 ? formatTrackCountLabel(count, stats) : formatTrackTotal(count);

export function describeFlowSchedule(flow, now) {
  if (isEditorialFlow(flow)) return "No longer updates";
  if (flow?.enabled !== true) return "Off";
  const next = formatNextRun(flow.nextRunAt, now);
  if (!next) return null;
  return next === "soon" ? "Next update soon" : `Next update in ${next}`;
}

export const getFlowActivityMessage = ({ flow, status, stats, rerunning = false }) =>
  getPlaylistRunActivity({
    playlistId: flow?.id,
    kind: "flow",
    enabled: flow?.enabled === true,
    status,
    stats,
    rerunning,
  })?.message || null;

const normalizePlaylistJobs = (jobs) =>
  (Array.isArray(jobs) ? jobs : []).map((job) => ({
    ...job,
    albumName: job?.albumName || null,
    reason: job?.reason || null,
    streamUrl: job?.status === "done" && job?.id ? getPlaylistTrackStreamUrl(job.id) : null,
  }));

export function usePlaylistTracks(playlistId, { pollAvailability = false } = {}) {
  const queryKey = queryKeys.playlistJobs(playlistId);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getPlaylistJobs(playlistId, null, { signal }).then(normalizePlaylistJobs),
    enabled: Boolean(playlistId),
    staleTime: 15_000,
    refetchInterval: (currentQuery) => {
      if (!pollAvailability) return false;
      return currentQuery.state.data?.some((track) =>
        ["pending", "downloading"].includes(track.status),
      )
        ? 4000
        : 30000;
    },
  });
  const tracks = useMemo(() => query.data || [], [query.data]);
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.playlistJobs(playlistId) }),
    [playlistId],
  );
  return {
    tracks,
    loading: query.isPending,
    error: query.error?.response?.data?.message || query.error?.message || "",
    refresh,
  };
}

export function exportPlaylistTracklist(entry, jobs, { sourceFlowId = null } = {}) {
  const tracks = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.status !== "failed")
    .map((job) => ({
      artistName: job.artistName,
      trackName: job.trackName,
      albumName: job.albumName || null,
      artistMbid: job.artistMbid || null,
      albumMbid: job.albumMbid || null,
      trackMbid: job.trackMbid || null,
      releaseYear: job.releaseYear || null,
      durationMs: job.durationMs || null,
      artistAliases: job.artistAliases || [],
    }))
    .filter((track) => track.artistName && track.trackName);
  if (tracks.length === 0) {
    throw new Error("No tracks available to export yet");
  }
  downloadTracklistFile(
    `aurral-tracklist-${slugifyFilePart(entry.name)}.json`,
    buildStaticTracklistPayload({
      name: entry.name,
      sourceName: entry.name,
      sourceFlowId,
      tracks,
    }),
  );
}

export function usePlaylistArtwork() {
  const { data: revisions } = useQuery({
    queryKey: queryKeys.playlistArtworkRevisions,
    queryFn: () => ({}),
    initialData: {},
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const artworkUrlFor = useCallback(
    (playlistId) => getPlaylistArtworkUrl(playlistId, revisions[playlistId]),
    [revisions],
  );
  const bumpArtwork = useCallback((playlistId) => {
    queryClient.setQueryData(queryKeys.playlistArtworkRevisions, (current = {}) => ({
      ...current,
      [playlistId]: (current[playlistId] || 0) + 1,
    }));
  }, []);
  return { artworkUrlFor, bumpArtwork };
}
