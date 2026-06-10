import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { getFlowStatus, getFlowJobs } from "../../utils/api";
import { useWebSocketChannel } from "../../hooks/useWebSocket";
import {
  buildFlowStatsFromJobs,
  sanitizeFlowStats,
  EMPTY_FLOW_STATS,
  getPlaylistStateFromStats,
} from "./flowStats";

export function useFlowStatus() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [flowStatsById, setFlowStatsById] = useState({});
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const lastFlowWsMessageAtRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await getFlowStatus();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFlowStatusMessage = useCallback((msg) => {
    if (msg?.type !== "weekly_flow_status") return;
    if (!msg?.status || typeof msg.status !== "object") return;
    lastFlowWsMessageAtRef.current = Date.now();
    setStatus(msg.status);
    setLoading(false);
  }, []);

  const { isConnected: isFlowSocketConnected } = useWebSocketChannel(
    "weekly-flow",
    handleFlowStatusMessage,
  );

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (isFlowSocketConnected) {
      fetchStatus();
    }
  }, [isFlowSocketConnected, fetchStatus]);

  useEffect(() => {
    const workerRunning = status?.worker?.running === true;
    const hintPhase = status?.hint?.phase;
    const inTransition =
      hintPhase === "preparing" || hintPhase === "downloading";
    if (!workerRunning && !inTransition) return;
    const hasRecentWsUpdate =
      Date.now() - lastFlowWsMessageAtRef.current < 20000;
    if (isFlowSocketConnected && hasRecentWsUpdate) return;
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [
    status?.worker?.running,
    status?.hint?.phase,
    isFlowSocketConnected,
    fetchStatus,
  ]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdownNow(Date.now());
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const activeFlowIdsKey = useMemo(() => {
    if (!status?.worker?.running) return "";
    const activeItems = [
      ...(Array.isArray(status?.flows) ? status.flows : []),
      ...(Array.isArray(status?.sharedPlaylists) ? status.sharedPlaylists : []),
    ];
    if (!activeItems.length) return "";
    const activeIds = activeItems
      .filter((flow) => {
        const stats =
          status.flowStats?.[flow.id] || status.sharedPlaylistStats?.[flow.id];
        return (stats?.pending || 0) > 0 || (stats?.downloading || 0) > 0;
      })
      .map((flow) => flow.id)
      .sort();
    return activeIds.join("|");
  }, [
    status?.worker?.running,
    status?.flows,
    status?.sharedPlaylists,
    status?.flowStats,
    status?.sharedPlaylistStats,
  ]);

  useEffect(() => {
    if (!activeFlowIdsKey) return;
    const activeFlowIds = activeFlowIdsKey.split("|").filter(Boolean);
    if (!activeFlowIds.length) return;

    let cancelled = false;
    const fetchIncrementalJobs = async () => {
      try {
        const results = await Promise.all(
          activeFlowIds.map((flowId) =>
            getFlowJobs(flowId).then((jobs) => ({
              flowId,
              stats: buildFlowStatsFromJobs(jobs),
            })),
          ),
        );
        if (cancelled) return;
        setFlowStatsById((prev) => {
          const next = { ...prev };
          for (const result of results) {
            next[result.flowId] = result.stats;
          }
          return next;
        });
      } catch {}
    };

    fetchIncrementalJobs();
    const interval = setInterval(fetchIncrementalJobs, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeFlowIdsKey]);

  useEffect(() => {
    const playlistIds = new Set([
      ...(Array.isArray(status?.flows) ? status.flows.map((flow) => flow.id) : []),
      ...(Array.isArray(status?.sharedPlaylists)
        ? status.sharedPlaylists.map((playlist) => playlist.id)
        : []),
    ]);
    if (playlistIds.size === 0) {
      setFlowStatsById({});
      return;
    }
    setFlowStatsById((prev) => {
      const next = {};
      for (const [flowId, stats] of Object.entries(prev)) {
        if (playlistIds.has(flowId)) {
          next[flowId] = stats;
        }
      }
      return next;
    });
  }, [status?.flows, status?.sharedPlaylists]);

  const getPlaylistStats = useCallback(
    (flowId) =>
      sanitizeFlowStats(
        status?.flowStats?.[flowId] ||
          status?.sharedPlaylistStats?.[flowId] ||
          flowStatsById[flowId] ||
          EMPTY_FLOW_STATS,
      ),
    [
      status?.flowStats,
      status?.sharedPlaylistStats,
      flowStatsById,
    ],
  );

  const getPlaylistState = useCallback(
    (flowId) => getPlaylistStateFromStats(getPlaylistStats(flowId)),
    [getPlaylistStats],
  );

  const sharedPlaylists = useMemo(
    () => status?.sharedPlaylists || [],
    [status?.sharedPlaylists],
  );

  const flows = useMemo(() => status?.flows || [], [status?.flows]);

  const enabledFlowCount = useMemo(
    () => flows.filter((flow) => flow.enabled === true).length,
    [flows],
  );

  const runningCount = useMemo(() => {
    let count = 0;
    for (const flow of flows) {
      if (getPlaylistState(flow.id) === "running") count += 1;
    }
    for (const playlist of sharedPlaylists) {
      if (getPlaylistState(playlist.id) === "running") count += 1;
    }
    return count;
  }, [flows, sharedPlaylists, getPlaylistState]);

  const completedCount = useMemo(() => {
    let count = 0;
    for (const flow of flows) {
      if (getPlaylistState(flow.id) === "completed") count += 1;
    }
    for (const playlist of sharedPlaylists) {
      if (getPlaylistState(playlist.id) === "completed") count += 1;
    }
    return count;
  }, [flows, sharedPlaylists, getPlaylistState]);

  return {
    status,
    loading,
    fetchStatus,
    isFlowSocketConnected,
    flowStatsById,
    countdownNow,
    getPlaylistStats,
    getPlaylistState,
    sharedPlaylists,
    flows,
    enabledFlowCount,
    runningCount,
    completedCount,
  };
}
