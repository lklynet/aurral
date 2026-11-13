import { useCallback, useState } from "react";
import type { InferResponseType } from "hono/client";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.ts";
import { describeAlbumRequestResult } from "../utils/albumAddAction";
import { asApiError } from "../utils/api/core.ts";
import { getApiErrorText } from "../utils/api/errors.ts";
import { libraryMiscClient } from "../utils/api/clients/libraryMisc.ts";
import { requestAlbumFromSearch } from "../utils/api/endpoints/library.ts";

export type RecentRelease = InferResponseType<
  (typeof libraryMiscClient)["recent-releases"]["$get"],
  200
>[number];

const releaseKey = (album: RecentRelease) => album.mbid || album.foreignAlbumId || album.id;

export function useReleaseAlbumAction() {
  const { hasPermission } = useAuth();
  const { showSuccess, showError, showInfo } = useToast();
  const [pendingIds, setPendingIds] = useState<Record<string, boolean>>({});

  const onAlbumAction = useCallback(
    async (album: RecentRelease) => {
      const albumKey = releaseKey(album);
      const albumMbid = album.mbid || album.foreignAlbumId;
      const artistMbid = album.artistMbid || album.foreignArtistId;
      if (!albumMbid || !artistMbid || !albumKey) return;
      setPendingIds((prev) => ({ ...prev, [albumKey]: true }));
      try {
        const result = await requestAlbumFromSearch({
          albumMbid,
          albumName: album.albumName || album.title,
          artistMbid,
          artistName: album.artistName,
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.releases() });
        const outcome = describeAlbumRequestResult(
          result,
          album.albumName || album.title || "album",
        );
        (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
      } catch (err) {
        showError(
          `Could not download the album: ${
            getApiErrorText(err, "message") ||
            getApiErrorText(err, "error") ||
            asApiError(err)?.message
          }`,
        );
      } finally {
        setPendingIds(({ [albumKey]: _, ...prev }) => prev);
      }
    },
    [showError, showInfo, showSuccess],
  );

  return {
    canAddAlbum: hasPermission("addAlbum"),
    isPending: (album: RecentRelease) => !!pendingIds[releaseKey(album)],
    onAlbumAction,
  };
}
