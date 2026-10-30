import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getReleaseGroupCover } from "../../utils/api/endpoints/artists.ts";
import { withImageCacheBust } from "../../utils/normalizeMediaUrl.ts";
import { getCoverImage } from "../ArtistDetails/utils";

// A cover that fails to load is refetched once without the cache, then dropped for the
// letter fallback.
export function useReleaseCover({
  releaseGroupMbid,
  seedUrl,
  artistName,
  albumTitle,
  enabled,
}: {
  releaseGroupMbid: string | null;
  seedUrl: string;
  artistName: string;
  albumTitle: string | undefined;
  enabled: boolean;
}) {
  const failureKey = `${releaseGroupMbid}|${seedUrl}`;
  const [failure, setFailure] = useState({ key: "", count: 0 });
  const failures = failure.key === failureKey ? failure.count : 0;
  const coverQuery = useQuery({
    queryKey: ["release-group-cover", releaseGroupMbid, artistName, albumTitle, failures > 0],
    queryFn: () =>
      getReleaseGroupCover(releaseGroupMbid!, {
        artistName,
        albumTitle,
        bypassCache: failures > 0,
      }),
    enabled: enabled && Boolean(releaseGroupMbid) && failures < 2 && (failures > 0 || !seedUrl),
    placeholderData: (previous) => previous,
    staleTime: Infinity,
  });
  const fetched = getCoverImage(
    coverQuery.data && "images" in coverQuery.data ? coverQuery.data.images : undefined,
  );
  const latest = fetched || seedUrl;
  const src = failures >= 2 || !latest ? "" : failures === 1 ? withImageCacheBust(latest) : latest;
  return { src, onError: () => setFailure({ key: failureKey, count: failures + 1 }) };
}
