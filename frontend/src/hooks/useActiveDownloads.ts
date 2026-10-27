import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { queryClient, queryKeys } from "../queryClient.ts";
import { libraryDownloadsClient } from "../utils/api/clients/libraryDownloads.ts";
import { clearLibraryPageCache } from "../utils/api/endpoints/library.ts";
import type { ActiveDownloadTrack } from "../utils/activeDownloads.ts";
import {
  finishedActiveDownloads,
  hasActiveDownloads,
  indexActiveDownloads,
  isAlbumDownloading,
  isArtistDownloading,
  isTrackDownloading,
  normalizeActiveDownloads,
} from "../utils/activeDownloads.ts";

const ACTIVE_POLL_MS = 5_000;

const refreshFinishedDownloads = () => {
  clearLibraryPageCache();
  void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPrefix });
  void queryClient.invalidateQueries({ queryKey: ["search"] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.artistDetailsPrefix });
};

const fetchActiveDownloads = async ({ signal }: { signal: AbortSignal }) => {
  const previous = queryClient.getQueryData(queryKeys.activeDownloads);
  const next = normalizeActiveDownloads(
    await parseResponse(
      libraryDownloadsClient.downloads.active.$get(undefined, { init: { signal } }),
    ),
  );
  if (previous && finishedActiveDownloads(previous, next)) refreshFinishedDownloads();
  return next;
};

export function useActiveDownloads() {
  const { data } = useQuery({
    queryKey: queryKeys.activeDownloads,
    queryFn: fetchActiveDownloads,
    staleTime: ACTIVE_POLL_MS,
    refetchInterval: (query) => (hasActiveDownloads(query.state.data) ? ACTIVE_POLL_MS : false),
  });
  return useMemo(() => {
    const index = indexActiveDownloads(data);
    return {
      isAlbumDownloading: (albumMbid: string | null | undefined) =>
        isAlbumDownloading(index, albumMbid),
      isArtistDownloading: (artistMbid: string | null | undefined) =>
        isArtistDownloading(index, artistMbid),
      isTrackDownloading: (track: ActiveDownloadTrack | null | undefined) =>
        isTrackDownloading(index, track),
    };
  }, [data]);
}
