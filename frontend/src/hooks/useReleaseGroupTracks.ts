import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../queryClient.ts";
import {
  getReleaseGroupPreviews,
  getReleaseGroupTracks,
  type ReleaseGroupTrack,
} from "../utils/api/endpoints/artists.ts";

const NO_TRACKS: ReleaseGroupTrack[] = [];

export function useReleaseGroupTracks(
  releaseGroupMbid: string | null | undefined,
  hints: { artistMbid?: string; deezerAlbumId?: string; release?: string } = {},
) {
  const mbid = releaseGroupMbid || null;
  const tracksQuery = useQuery({
    queryKey: queryKeys.releaseGroupTracks(mbid, hints.release),
    queryFn: ({ signal }) => getReleaseGroupTracks(mbid ?? "", { release: hints.release, signal }),
    enabled: Boolean(mbid),
    staleTime: 5 * 60 * 1000,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === mbid ? previous : undefined,
  });
  const previewsQuery = useQuery({
    queryKey: queryKeys.releaseGroupPreviews(mbid, hints),
    queryFn: ({ signal }) => getReleaseGroupPreviews(mbid ?? "", { ...hints, signal }),
    enabled: Boolean(mbid),
    staleTime: 5 * 60 * 1000,
  });
  const previews = previewsQuery.data?.previews;
  const tracks = useMemo<ReleaseGroupTrack[]>(
    () =>
      tracksQuery.data && previews
        ? tracksQuery.data.map((track) => ({ ...track, ...previews[track.mbid] }))
        : (tracksQuery.data ?? NO_TRACKS),
    [previews, tracksQuery.data],
  );
  return { tracks, isPending: Boolean(mbid) && tracksQuery.isPending, error: tracksQuery.error };
}
