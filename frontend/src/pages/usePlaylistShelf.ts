import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { madeForYouQueryOptions, playlistShelfQueryOptions } from "../queryOptions.ts";
import type { ShelfScope } from "../../../backend/services/importLists/deezerPlaylists.ts";

export function usePlaylistShelf(scope?: ShelfScope) {
  const { user } = useAuth();
  return useQuery(playlistShelfQueryOptions(user?.id, scope));
}

export function useMadeForYou() {
  const { user } = useAuth();
  return useQuery(madeForYouQueryOptions(user?.id));
}
