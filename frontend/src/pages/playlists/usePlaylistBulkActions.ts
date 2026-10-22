import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useToast } from "../../contexts/ToastContext";
import { createPlaylistTrackChanges } from "./playlistTrackChanges.ts";

type PlaylistTrackChanges = ReturnType<typeof createPlaylistTrackChanges>;

const BulkActionsContext = createContext<PlaylistTrackChanges | null>(null);

export function PlaylistBulkActionsProvider({ children }: { children: ReactNode }) {
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

function usePlaylistTrackChanges() {
  const changes = useContext(BulkActionsContext);
  if (!changes) {
    throw new Error("Playlist bulk actions must be used within PlaylistBulkActionsProvider");
  }
  return changes;
}

export function usePlaylistBulkActions() {
  const changes = usePlaylistTrackChanges();
  return {
    removeTracks: changes.remove,
    moveTracks: changes.move,
  };
}

export function useHiddenPlaylistTracks() {
  const changes = usePlaylistTrackChanges();
  return useSyncExternalStore(changes.subscribe, changes.getHidden, changes.getHidden);
}
