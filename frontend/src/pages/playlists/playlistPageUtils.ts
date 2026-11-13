import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Circle, CircleDot, Square, SquareCheck } from "../../components/icons";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { playlistJobsQueryOptions } from "../../queryOptions.ts";
import { getPlaylistRunActivity } from "./playlistRunActivity";
import lastfmLogo from "../../../images/logos/last-fm-color.svg";
import listenbrainzLogo from "../../../images/logos/listenbrainz-color.svg";
import spotifyLogo from "../../../images/logos/spotify-color.svg";
import youtubeMusicLogo from "../../../images/logos/youtube-music-color.svg";
import deezerLogo from "../../../images/logos/deezer-color.svg";
import {
  formatTrackCountLabel,
  type Flow,
  type PlaylistStats,
  type PlaylistStatus,
} from "../../utils/playlistStats";
import { getApiErrorText } from "../../utils/api/errors.ts";
import { IMPORT_PROVIDER_LABELS, isNativeImportProvider } from "../../../../lib/importProviders.ts";

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
  if (String(provider || "").startsWith("aurral-")) return "/arralogo.svg";
  return null;
}

export const getImportedProviderLabel = (provider: string | null | undefined) =>
  isNativeImportProvider(provider) ? IMPORT_PROVIDER_LABELS[provider] : "Spotify";

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

export const getFlowActivity = ({
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
  });

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
