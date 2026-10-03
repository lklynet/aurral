import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, queryKeys } from "../queryClient.js";
import {
  clearCanonicalLibraryPageCache,
  getActiveDownloads,
} from "../utils/api/endpoints/library.js";
import {
  finishedActiveDownloads,
  hasActiveDownloads,
  indexActiveDownloads,
  isAlbumDownloading,
  isArtistDownloading,
  isTrackDownloading,
  normalizeActiveDownloads,
} from "../utils/activeDownloads.js";

const ACTIVE_POLL_MS = 5_000;

const refreshFinishedDownloads = () => {
  clearCanonicalLibraryPageCache();
  void queryClient.invalidateQueries({ queryKey: queryKeys.libraryPrefix });
  void queryClient.invalidateQueries({ queryKey: ["search"] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.artistDetailsPrefix });
};

const fetchActiveDownloads = async ({ signal }) => {
  const previous = queryClient.getQueryData(queryKeys.activeDownloads);
  const next = normalizeActiveDownloads(await getActiveDownloads({ signal }));
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
      isAlbumDownloading: (albumMbid) => isAlbumDownloading(index, albumMbid),
      isArtistDownloading: (artistMbid) => isArtistDownloading(index, artistMbid),
      isTrackDownloading: (track) => isTrackDownloading(index, track),
    };
  }, [data]);
}
