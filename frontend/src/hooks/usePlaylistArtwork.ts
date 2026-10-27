import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { playlistStatusQueryOptions } from "../queryOptions.ts";
import { getPlaylistArtworkUrl } from "../utils/api/endpoints/playlists.ts";
import { queryClient, queryKeys } from "../queryClient.ts";

export function usePlaylistArtwork() {
  const { data: serverRevisions } = useQuery({
    ...playlistStatusQueryOptions(),
    enabled: false,
    select: (status) =>
      Object.fromEntries(
        [...status.flows, ...status.sharedPlaylists].map(
          (entry) => [entry.id, entry.artworkRevision] as const,
        ),
      ),
  });
  const { data: revisions } = useQuery<Record<string, number | undefined>>({
    queryKey: queryKeys.playlistArtworkRevisions,
    queryFn: () => ({}),
    initialData: {},
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const artworkUrlFor = useCallback(
    (playlistId: string) =>
      getPlaylistArtworkUrl(
        playlistId,
        `${serverRevisions?.[playlistId] || "current"}:${revisions[playlistId] || 0}`,
      ),
    [revisions, serverRevisions],
  );
  const bumpArtwork = useCallback((playlistId: string) => {
    queryClient.setQueryData(
      queryKeys.playlistArtworkRevisions,
      (current: Record<string, number | undefined> = {}) => ({
        ...current,
        [playlistId]: (current[playlistId] || 0) + 1,
      }),
    );
  }, []);
  return { artworkUrlFor, bumpArtwork };
}
