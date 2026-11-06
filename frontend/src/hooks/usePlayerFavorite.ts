import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "../contexts/ToastContext.tsx";
import { libraryViewQueryOptions } from "../pages/libraryViewQuery.ts";
import { queryClient, queryKeys } from "../queryClient.ts";
import {
  libraryFavoritesQueryOptions,
  updateLibraryFavorites,
} from "../utils/api/endpoints/library.ts";
import { getApiErrorText } from "../utils/api/errors.ts";
import { showFavoriteRemoved } from "../utils/favoriteUndo.ts";
import { favoriteId } from "../utils/libraryPageData.ts";

type FavoriteTrack = {
  title?: string | null;
  isPreview?: boolean;
  favoriteId?: string | null;
  libraryTrackId?: string | number | null;
  libraryAlbumId?: string | number | null;
} | null;

export function usePlayerFavorite(track: FavoriteTrack) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const playable = track && !track.isPreview ? track : null;
  const albumId =
    playable?.libraryTrackId != null && playable.libraryAlbumId != null
      ? String(playable.libraryAlbumId)
      : null;
  const playlistFavoriteId = albumId === null ? playable?.favoriteId || null : null;
  const options = libraryViewQueryOptions({ albumId: albumId ?? "none" });
  const { data } = useQuery({ ...options, enabled: albumId !== null });
  const { data: favorites } = useQuery({
    ...libraryFavoritesQueryOptions,
    enabled: playlistFavoriteId !== null,
  });
  const libraryTrack =
    albumId === null || data?.isPreview
      ? undefined
      : data?.library?.tracks.find((entry) => String(entry.id) === String(track?.libraryTrackId));

  const target = libraryTrack
    ? {
        id: favoriteId("song", libraryTrack),
        name: libraryTrack.title,
        favorited: (id: string) => Boolean(data?.favoriteIds?.has(id)),
        apply: (ids: string[], starred: boolean) =>
          queryClient.setQueryData(options.queryKey, (current) => {
            if (!current) return current;
            const next = new Set(current.favoriteIds);
            for (const id of ids) {
              if (starred) next.add(id);
              else next.delete(id);
            }
            return { ...current, favoriteIds: next };
          }),
      }
    : playlistFavoriteId && favorites
      ? {
          id: playlistFavoriteId,
          name: track?.title || "",
          favorited: (id: string) => favorites.songIds.includes(id),
          apply: (ids: string[], starred: boolean) =>
            queryClient.setQueryData(libraryFavoritesQueryOptions.queryKey, (current) => {
              if (!current) return current;
              const rest = current.songIds.filter((id) => !ids.includes(id));
              return { ...current, songIds: starred ? [...rest, ...ids] : rest };
            }),
        }
      : null;
  if (!target) return null;

  const { id, name, apply } = target;
  const active = target.favorited(id);
  const refreshLibrary = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.libraryViewPrefix });

  const toggle = async () => {
    if (pending) return;
    const starred = !active;
    setPending(true);
    apply([id], starred);
    try {
      const result = await updateLibraryFavorites([id], starred);
      const changedIds = Array.isArray(result?.changedIds) ? result.changedIds : [id];
      apply(changedIds, starred);
      void refreshLibrary();
      if (!starred) {
        showFavoriteRemoved(toast, {
          name,
          removed: result?.removed,
          restore: () => apply(changedIds, true),
          revert: () => apply(changedIds, false),
          onRestored: refreshLibrary,
        });
      }
    } catch (error) {
      apply([id], active);
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
