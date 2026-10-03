import { createContext, createElement, useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "../../contexts/ToastContext";
import { queryClient, queryKeys } from "../../queryClient.js";
import { getStaticPlaylistOperation, moveStaticPlaylistTracks, removeStaticPlaylistTracks } from "../../utils/api/endpoints/playlists.js";

import { usePlaylistStatusQuery } from "./usePlaylistStatusQuery";

const BulkActionsContext = createContext(null);

export function PlaylistBulkActionsProvider({ children }) {
  const { showSuccess, showError } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [operation, setOperation] = useState(null);
  const { socketConnected } = usePlaylistStatusQuery({ enabled: Boolean(operation) });
  const reported = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const result = useQuery({
    queryKey: ["playlists", "bulk-operation", operation?.sourceId, operation?.id],
    queryFn: ({ signal }) => getStaticPlaylistOperation(operation.sourceId, operation.id, { signal, bypassCache: true }),
    enabled: Boolean(operation),
    staleTime: 0,
    refetchInterval: (query) => {
      if (document.hidden || ["completed", "failed"].includes(query.state.data?.state) || query.state.error?.response?.status === 404) return false;
      return 4000;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const refetchResult = result.refetch;
  useEffect(() => {
    if (operation && socketConnected) void refetchResult();
  }, [operation, socketConnected, refetchResult]);
  useEffect(() => {
    if (!operation || reported.current === operation.id) return;
    const terminal = ["completed", "failed"].includes(result.data?.state);
    const lostAccess = result.error?.response?.status === 404;
    if (!terminal && !lostAccess) return;
    reported.current = operation.id;
    if (lostAccess) showError(`Cannot read the queued action for ${operation.name}. Playlist access may have changed.`);
    else {
      const outcomes = result.data.outcomes || [];
      const succeeded = outcomes.filter((outcome) => ["removed", "moved"].includes(outcome.status)).length;
      const failed = outcomes.filter((outcome) => outcome.status === "failed");
      if (succeeded) showSuccess(`${succeeded} track${succeeded === 1 ? "" : "s"} ${operation.action === "move" ? "moved from" : "removed from"} ${operation.name}`);
      if (failed.length || result.data.state === "failed") {
        showError(`${operation.name}: ${failed.length ? `${failed.length} track${failed.length === 1 ? "" : "s"} failed. ${failed[0].message || ""}` : result.data.message || "Playlist synchronization failed. Review the playlist before retrying."}`);
      }
      if (!succeeded && !failed.length && result.data.state === "completed") showSuccess(`The selected tracks are already absent from ${operation.name}`);
    }
    const affected = new Set([operation.sourceId, result.data?.targetPlaylistId].filter(Boolean));
    for (const id of affected) void queryClient.invalidateQueries({ queryKey: queryKeys.playlistJobs(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.playlistStatus });
    setOperation(null);
  }, [operation, result.data, result.error, showSuccess, showError]);

  async function submit(source, tracks, target) {
    const jobIds = [...new Set(tracks.map((track) => track?.id).filter(Boolean))];
    if (!source || !jobIds.length || submitting || operation) return;
    const action = target ? "move" : "remove";
    setSubmitting(true);
    try {
      const destination = target?.mode === "new"
        ? { name: String(target.name || "").trim() || "Playlist" }
        : target ? { playlistId: target.playlistId } : null;
      const response = destination ? await moveStaticPlaylistTracks(source.id, jobIds, destination) : await removeStaticPlaylistTracks(source.id, jobIds);
      if (!mounted.current) return;
      if (response.rejected?.length) showError(`${response.rejected.length} selected track${response.rejected.length === 1 ? "" : "s"} could not be queued. ${response.rejected[0].message}`);
      if (response.queued) {
        reported.current = null;
        setOperation({ id: response.operationId, sourceId: source.id, name: source.name, action });
        showSuccess(`${action === "move" ? "Move" : "Removal"} queued for ${response.acceptedJobIds.length} track${response.acceptedJobIds.length === 1 ? "" : "s"}`);
      }
    } catch (error) {
      if (mounted.current) showError(error.response?.data?.message || error.response?.data?.error ||
        "The request outcome is unknown. Check the playlist before submitting again.");
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }
  return createElement(BulkActionsContext.Provider, {
    value: { bulkLoading: submitting || Boolean(operation), removeTracks: (source, tracks) => submit(source, tracks), moveTracks: submit },
  }, children);
}

export function usePlaylistBulkActions() {
  return useContext(BulkActionsContext);
}
