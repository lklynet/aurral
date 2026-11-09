import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import {
  madeForYouQueryOptions,
  playlistShelfQueryOptions,
  playlistStatusQueryOptions,
} from "../queryOptions.ts";
import type { ShelfScope } from "../../../backend/services/importLists/deezerPlaylists.ts";
import type { BrowseProvider } from "../../../lib/browsePlaylists.ts";

const GROUP_ORDER = ["mood", "decade", "genre"] as const;

export function usePlaylistShelf(scope?: ShelfScope) {
  const { user } = useAuth();
  return useQuery(playlistShelfQueryOptions(user?.id, scope));
}

export function useMadeForYou() {
  const { user } = useAuth();
  return useQuery(madeForYouQueryOptions(user?.id));
}

export function usePlaylistCategories() {
  const madeForYou = useMadeForYou();
  const shelf = usePlaylistShelf();
  const browse = useMemo(
    () =>
      GROUP_ORDER.flatMap((group) =>
        (shelf.data?.categories ?? []).filter(
          (category) => category.group === group && category.playlists.length > 0,
        ),
      ),
    [shelf.data],
  );
  const categories = useMemo(
    () => [
      ...[
        { id: "made-for-you", name: "Made for you", playlists: madeForYou.data?.discovery ?? [] },
        { id: "for-you", name: "Your genres", playlists: shelf.data?.forYou ?? [] },
      ].filter((category) => category.playlists.length > 0),
      ...browse,
    ],
    [madeForYou.data, shelf.data, browse],
  );
  return { categories, browse, madeForYou, shelf };
}

export function usePlaylistClaims() {
  const { user } = useAuth();
  const { data: claims } = useQuery({
    ...playlistStatusQueryOptions(),
    enabled: false,
    select: (status) =>
      new Map(
        status.staticPlaylists.flatMap(({ ownerUserId, importSource }) =>
          ownerUserId === user?.id &&
          importSource?.provider === "deezer-playlist" &&
          importSource.externalId
            ? [[importSource.externalId, importSource.syncEnabled ? "synced" : "saved"] as const]
            : [],
        ),
      ),
  });
  return useCallback(
    (playlist: { provider: BrowseProvider; id: string }) =>
      playlist.provider === "deezer" ? claims?.get(playlist.id) : undefined,
    [claims],
  );
}

export const playlistCategoryPath = (id: string) => `/discover/playlists/${encodeURIComponent(id)}`;
