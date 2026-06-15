import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { getFlowStatus } from "../../utils/api";
import { useWebSocketChannel } from "../../hooks/useWebSocket";
import { hasFlowWorkerActivity } from "./flowStats";

const POLL_INTERVAL_MS = 4000;
const WS_RECENT_MS = 3000;

export function useFlowWorkerActivity({ enabled = true } = {}) {
  const [status, setStatus] = useState(null);
  const lastFlowWsMessageAtRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await getFlowStatus();
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, [enabled]);

  const handleFlowStatusMessage = useCallback(
    (msg) => {
      if (!enabled) return;
      if (msg?.type !== "playlist_status") {
        return;
      }
      if (!msg?.status || typeof msg.status !== "object") return;
      lastFlowWsMessageAtRef.current = Date.now();
      setStatus(msg.status);
    },
    [enabled],
  );

  const { isConnected: isFlowSocketConnected } = useWebSocketChannel(
    "playlists",
    handleFlowStatusMessage,
    { enabled },
  );
  useWebSocketChannel("weekly-flow", handleFlowStatusMessage, { enabled });

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    fetchStatus();
  }, [enabled, fetchStatus]);

  useEffect(() => {
    if (!enabled) return;
    if (isFlowSocketConnected) {
      fetchStatus();
    }
  }, [enabled, isFlowSocketConnected, fetchStatus]);

  useEffect(() => {
    if (!enabled) return;

    const poll = () => {
      const hasRecentWsUpdate =
        Date.now() - lastFlowWsMessageAtRef.current < WS_RECENT_MS;
      if (isFlowSocketConnected && hasRecentWsUpdate) return;
      fetchStatus();
    };

    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, isFlowSocketConnected, fetchStatus]);

  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchStatus();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [enabled, fetchStatus]);

  const hasActivity = useMemo(
    () => hasFlowWorkerActivity(status),
    [status],
  );

  return { hasActivity, status };
}
