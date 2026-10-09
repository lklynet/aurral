import { createContext, createElement, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { useToast } from "../../contexts/ToastContext";
import { createPlaylistTrackChanges } from "./playlistTrackChanges.js";

const BulkActionsContext = createContext(null);

export function PlaylistBulkActionsProvider({ children }) {
  const toast = useToast();
  const [changes] = useState(() => createPlaylistTrackChanges(toast));

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") changes.flush();
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", changes.flush);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", changes.flush);
    };
  }, [changes]);

  return createElement(BulkActionsContext.Provider, { value: changes }, children);
}

export function usePlaylistBulkActions() {
  const changes = useContext(BulkActionsContext);
  return {
    removeTracks: changes.remove,
    moveTracks: changes.move,
  };
}

export function useHiddenPlaylistTracks() {
  const changes = useContext(BulkActionsContext);
  return useSyncExternalStore(changes.subscribe, changes.getHidden, changes.getHidden);
}
