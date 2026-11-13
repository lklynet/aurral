import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import {
  madeForYouQueryOptions,
  playlistShelfQueryOptions,
  playlistStatusQueryOptions,
} from "../queryOptions.ts";
import type { ShelfScope } from "../../../backend/services/importLists/deezerPlaylists.ts";
import { BROWSE_IMPORT_PROVIDERS, type BrowseProvider } from "../../../lib/browsePlaylists.ts";

const GROUP_ORDER = ["mood", "decade", "genre"] as const;

export function usePlaylistShelf(scope?: ShelfScope) {
  const { user } = useAuth();
  return useQuery(playlistShelfQueryOptions(user?.id, scope));
}

export function useMadeForYou() {
  const { user } = useAuth();
  return useQuery({
    ...madeForYouQueryOptions(user?.id),
    select: ({ discovery, mixes }) => ({ mixes, playlists: [...discovery, ...mixes] }),
  });
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
        { id: "made-for-you", name: "Made for you", playlists: madeForYou.data?.playlists ?? [] },
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
          ownerUserId === user?.id && importSource?.externalId
            ? [
                [
                  `${importSource.provider}:${importSource.externalId}`,
                  importSource.syncEnabled ? "synced" : "saved",
                ] as const,
              ]
            : [],
        ),
      ),
  });
  return useCallback(
    (playlist: { provider: BrowseProvider; id: string }) =>
      claims?.get(`${BROWSE_IMPORT_PROVIDERS[playlist.provider]}:${playlist.id}`),
    [claims],
  );
}

export const playlistCategoryPath = (id: string) => `/discover/playlists/${encodeURIComponent(id)}`;
