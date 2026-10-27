import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Circle, CircleDot, Square, SquareCheck } from "../../components/icons";
import { getPlaylistArtworkUrl } from "../../utils/api/playlistUrls.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { playlistJobsQueryOptions } from "../../queryOptions.ts";
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
import {
  formatTrackCountLabel,
  isEditorialFlow,
  type Flow,
  type PlaylistStats,
  type PlaylistStatus,
  type StaticPlaylist,
} from "./playlistStats";
import { getApiErrorText } from "../onboardingUtils.tsx";

export const SYNCABLE_IMPORT_PROVIDERS = new Set<string | null | undefined>([
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

export function getImportedProviderLogo(provider: string | null | undefined) {
  if (String(provider || "").startsWith("listenbrainz-")) return listenbrainzLogo;
  if (provider === "lastfm-station") return lastfmLogo;
  if (provider === "youtube-music-playlist") return youtubeMusicLogo;
  if (provider === "deezer-playlist") return deezerLogo;
  if (provider === "spotify-playlist") return spotifyLogo;
  return null;
}

export function getImportedProviderLabel(provider: string | null | undefined) {
  if (String(provider || "").startsWith("listenbrainz-")) return "ListenBrainz";
  if (provider === "lastfm-station") return "Last.fm";
  if (provider === "youtube-music-playlist") return "YouTube Music";
  if (provider === "deezer-playlist") return "Deezer";
  return "Spotify";
}

export const optionMenuItem = <T extends { checked: boolean }>({ checked, ...item }: T) => ({
  ...item,
  checked,
  icon: checked ? SquareCheck : Square,
});

export const choiceMenuItem = <T extends { checked: boolean }>({ checked, ...item }: T) => ({
  ...item,
  checked,
  icon: checked ? CircleDot : Circle,
});

export const formatTrackTotal = (count: number) => `${count} ${count === 1 ? "track" : "tracks"}`;

export const formatFlowTrackLabel = (count: number, stats: PlaylistStats | null | undefined) =>
  Number(stats?.total || 0) > 0 ? formatTrackCountLabel(count, stats) : formatTrackTotal(count);

export function describeFlowSchedule(flow: Partial<Flow> | null | undefined, now: number) {
  if (isEditorialFlow(flow)) return "No longer updates";
  if (flow?.enabled !== true) return "Off";
  const next = formatNextRun(flow.nextRunAt, now);
  if (!next) return null;
  return next === "soon" ? "Next update soon" : `Next update in ${next}`;
}

export const getFlowActivityMessage = ({
  flow,
  status,
  stats,
  rerunning = false,
}: {
  flow: Partial<Flow> | null | undefined;
  status?: PlaylistStatus | null;
  stats?: Partial<PlaylistStats> | null;
  rerunning?: boolean;
}) =>
  getPlaylistRunActivity({
    playlistId: flow?.id,
    kind: "flow",
    enabled: flow?.enabled === true,
    status,
    stats,
    rerunning,
  })?.message || null;

export type PlaylistTrackRow = ReturnType<typeof usePlaylistTracks>["tracks"][number];

export function usePlaylistTracks(
  playlistId: string | null | undefined,
  { pollAvailability = false }: { pollAvailability?: boolean } = {},
) {
  const query = useQuery({
    ...playlistJobsQueryOptions(playlistId),
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
    error: getApiErrorText(query.error, "message") || query.error?.message || "",
    refresh,
  };
}

export function exportPlaylistTracklist(
  entry: Pick<StaticPlaylist, "name">,
  jobs: PlaylistTrackRow[],
  { sourceFlowId = null }: { sourceFlowId?: string | null } = {},
) {
  const tracks = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.status !== "failed")
    .map((job) => ({
      artistName: job.artistName,
      trackName: job.trackName,
      albumName: job.albumName || null,
      artistMbid: job.artistMbid || null,
      albumMbid: job.albumMbid || null,
      releaseMbid: job.releaseMbid || null,
      trackMbid: job.trackMbid || null,
      releaseYear: job.releaseYear || null,
      durationMs: job.durationMs || null,
      trackNumber: job.trackNumber || null,
      discNumber: job.discNumber || null,
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
  const { data: revisions } = useQuery<Record<string, number | undefined>>({
    queryKey: queryKeys.playlistArtworkRevisions,
    queryFn: () => ({}),
    initialData: {},
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const artworkUrlFor = useCallback(
    (playlistId: string) => getPlaylistArtworkUrl(playlistId, revisions[playlistId]),
    [revisions],
  );
  const bumpArtwork = useCallback((playlistId: string) => {
    queryClient.setQueryData(
      queryKeys.playlistArtworkRevisions,
      (current: Record<string, number | undefined> = {}) => ({
        ...current,
        [playlistId]: (current[playlistId] || 0) + 1,
      }),
    );
  }, []);
  return { artworkUrlFor, bumpArtwork };
}
