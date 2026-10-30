import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "../../contexts/ToastContext";
import {
  requestAlbumFromSearch,
  settleLibraryOwnerConflict,
} from "../../utils/api/endpoints/library.ts";
import { describeAlbumRequestResult } from "../../utils/albumAddAction.ts";
import { buildAlbumRequestPayload } from "../../utils/libraryDestination.ts";
import { buildAurralAlbumRetryPayload } from "../../utils/aurralAlbumStatus.ts";
import type { LibraryAlbum, LibraryArtist } from "../../utils/libraryPageData.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { getApiErrorMessage } from "../ArtistDetails/utils";

type OwnerConflict = NonNullable<ReturnType<typeof settleLibraryOwnerConflict>>;

export function useAlbumDownload({
  releaseGroupMbid,
  albumTitle,
  artistMbid,
  artistName,
  libraryAlbum,
  libraryArtist,
  triggerSearch,
  onLibraryAlbumRequested,
}: {
  releaseGroupMbid: string | null;
  albumTitle: string;
  artistMbid: string | null;
  artistName: string;
  libraryAlbum: LibraryAlbum | null;
  libraryArtist: LibraryArtist | null | undefined;
  triggerSearch: boolean;
  onLibraryAlbumRequested: (managedBy: string) => Promise<void> | void;
}) {
  const { showError, showInfo, showSuccess } = useToast();
  const [requesting, setRequesting] = useState(false);
  const [ownerConflictState, setOwnerConflictState] = useState<{
    key: string | null;
    conflict: OwnerConflict;
  } | null>(null);
  const conflictKey = releaseGroupMbid || (libraryAlbum ? String(libraryAlbum.id) : null);
  const ownerConflict =
    ownerConflictState && ownerConflictState.key === conflictKey
      ? ownerConflictState.conflict
      : null;
  const { mutateAsync: requestAlbum } = useMutation({ mutationFn: requestAlbumFromSearch });

  const requestLibraryAlbum = useCallback(
    async (album: LibraryAlbum, managedBy: string) => {
      const title = album.title || "album";
      const result = await requestAlbum({
        ...buildAurralAlbumRetryPayload({ album, artist: libraryArtist }),
        managedBy,
        triggerSearch: managedBy === "lidarr",
      });
      const queued = result?.jobIds?.length || 0;
      showSuccess(
        managedBy === "lidarr"
          ? describeAlbumRequestResult(result, title).message
          : queued > 0
            ? `Queued ${queued} ${queued === 1 ? "track" : "tracks"} from ${title}`
            : `Monitoring ${title}`,
      );
      await onLibraryAlbumRequested(managedBy);
    },
    [libraryArtist, onLibraryAlbumRequested, requestAlbum, showSuccess],
  );

  const requestReleaseAlbum = useCallback(
    async (albumMbid: string, managedBy: string) => {
      const result = await requestAlbum(
        buildAlbumRequestPayload({
          albumMbid,
          albumName: albumTitle,
          artistMbid,
          artistName,
          managedBy,
          triggerSearch,
        }),
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeys.libraryAlbumLookup([albumMbid]),
      });
      const outcome = describeAlbumRequestResult(result, albumTitle || "album");
      (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
    },
    [albumTitle, artistMbid, artistName, requestAlbum, showInfo, showSuccess, triggerSearch],
  );

  const downloadAlbum = useCallback(
    async (managedBy: string) => {
      if (requesting) return;
      if (!libraryAlbum && !releaseGroupMbid) return;
      setRequesting(true);
      try {
        if (libraryAlbum) await requestLibraryAlbum(libraryAlbum, managedBy);
        else await requestReleaseAlbum(releaseGroupMbid!, managedBy);
      } catch (requestError) {
        const conflict = settleLibraryOwnerConflict(requestError);
        if (conflict) {
          setOwnerConflictState({ key: conflictKey, conflict });
          showInfo(`${albumTitle || "Album"}: ${conflict.message}`);
          return;
        }
        showError(
          `Could not download ${albumTitle || "the album"}: ${
            getApiErrorMessage(requestError) || "Try again."
          }`,
        );
      } finally {
        setRequesting(false);
      }
    },
    [
      albumTitle,
      conflictKey,
      libraryAlbum,
      releaseGroupMbid,
      requestLibraryAlbum,
      requestReleaseAlbum,
      requesting,
      showError,
      showInfo,
    ],
  );

  return { downloadAlbum, requesting, ownerConflict };
}
