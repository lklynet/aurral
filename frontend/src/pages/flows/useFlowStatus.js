import { useEffect, useState, useCallback, useMemo } from "react";
import { sanitizeFlowStats, EMPTY_FLOW_STATS, getPlaylistStateFromStats } from "./flowStats";
import { usePlaylistStatusQuery } from "./usePlaylistStatusQuery";

export function useFlowStatus() {
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const { data: status, isPending: loading, fetchStatus } = usePlaylistStatusQuery();

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const interval = setInterval(() => setCountdownNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  const getPlaylistStats = useCallback(
    (flowId) =>
      sanitizeFlowStats(
        status?.flowStats?.[flowId] ||
          status?.sharedPlaylistStats?.[flowId] ||
          EMPTY_FLOW_STATS,
      ),
    [status?.flowStats, status?.sharedPlaylistStats],
  );

  const getPlaylistState = useCallback(
    (flowId) => getPlaylistStateFromStats(getPlaylistStats(flowId)),
    [getPlaylistStats],
  );

  const sharedPlaylists = useMemo(() => status?.sharedPlaylists || [], [status?.sharedPlaylists]);
  const flows = useMemo(() => status?.flows || [], [status?.flows]);

  return {
    status,
    loading,
    fetchStatus,
    countdownNow,
    getPlaylistStats,
    getPlaylistState,
    sharedPlaylists,
    flows,
  };
}
