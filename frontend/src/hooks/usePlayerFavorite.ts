import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "../contexts/ToastContext.tsx";
import { libraryViewQueryOptions } from "../pages/libraryViewQuery.ts";
import { queryClient, queryKeys } from "../queryClient.ts";
import { updateLibraryFavorites } from "../utils/api/endpoints/library.ts";
import { getApiErrorText } from "../utils/api/errors.ts";
import { showFavoriteRemoved } from "../utils/favoriteUndo.ts";
import { favoriteId } from "../utils/libraryPageData.ts";

type FavoriteTrack = {
  isPreview?: boolean;
  libraryTrackId?: string | number | null;
  libraryAlbumId?: string | number | null;
} | null;

export function usePlayerFavorite(track: FavoriteTrack) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const albumId =
    track && !track.isPreview && track.libraryTrackId != null && track.libraryAlbumId != null
      ? String(track.libraryAlbumId)
      : null;
  const options = libraryViewQueryOptions({ albumId: albumId ?? "none" });
  const { data } = useQuery({ ...options, enabled: albumId !== null });
  const libraryTrack =
    albumId === null || data?.isPreview
      ? undefined
      : data?.library?.tracks.find((entry) => String(entry.id) === String(track?.libraryTrackId));
  if (!libraryTrack) return null;

  const id = favoriteId("song", libraryTrack);
  const active = Boolean(data?.favoriteIds?.has(id));
  const name = libraryTrack.title;
  const applyFavorite = (ids: string[], starred: boolean) =>
    queryClient.setQueryData(options.queryKey, (current) => {
      if (!current) return current;
      const next = new Set(current.favoriteIds);
      for (const favorite of ids) {
        if (starred) next.add(favorite);
        else next.delete(favorite);
      }
      return { ...current, favoriteIds: next };
    });
  const refreshLibrary = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });

  const toggle = async () => {
    if (pending) return;
    const starred = !active;
    setPending(true);
    applyFavorite([id], starred);
    try {
      const result = await updateLibraryFavorites([id], starred);
      const changedIds = Array.isArray(result?.changedIds) ? result.changedIds : [id];
      applyFavorite(changedIds, starred);
      void refreshLibrary();
      if (!starred) {
        showFavoriteRemoved(toast, {
          name,
          removed: result?.removed,
          restore: () => applyFavorite(changedIds, true),
          revert: () => applyFavorite(changedIds, false),
          onRestored: refreshLibrary,
        });
      }
    } catch (error) {
      applyFavorite([id], active);
      toast.showError(
        `Could not ${starred ? "add" : "remove"} ${name || "this track"} ${starred ? "to" : "from"} favorites. Nothing changed. ${
          getApiErrorText(error, "message") || "Try again."
        }`,
      );
    } finally {
      setPending(false);
    }
  };

  return { active, pending, toggle, name };
}
