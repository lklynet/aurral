import { useEffect, useState, useCallback, useMemo } from "react";
import { sanitizePlaylistStats, EMPTY_PLAYLIST_STATS, getPlaylistStateFromStats } from "./playlistStats";
import { usePlaylistStatusQuery } from "./usePlaylistStatusQuery";

export function usePlaylistStatus() {
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const { data: status, isPending: loading, error, fetchStatus } = usePlaylistStatusQuery();

  useEffect(() => {
    const interval = setInterval(() => setCountdownNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  const getPlaylistStats = useCallback(
    (playlistId) =>
      sanitizePlaylistStats(
        status?.flowStats?.[playlistId] ||
          status?.sharedPlaylistStats?.[playlistId] ||
          EMPTY_PLAYLIST_STATS,
      ),
    [status?.flowStats, status?.sharedPlaylistStats],
  );

  const getPlaylistState = useCallback(
    (playlistId) => getPlaylistStateFromStats(getPlaylistStats(playlistId)),
    [getPlaylistStats],
  );

  const staticPlaylists = useMemo(() => status?.sharedPlaylists || [], [status?.sharedPlaylists]);
  const flows = useMemo(() => status?.flows || [], [status?.flows]);

  return {
    status,
    loading,
    error,
    fetchStatus,
    countdownNow,
    getPlaylistStats,
    getPlaylistState,
    staticPlaylists,
    flows,
  };
}
