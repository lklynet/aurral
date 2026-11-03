import { useState } from "react";
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
  const downloadAlbum = async (managedBy: string) => {
    if (requesting || !(libraryAlbum || releaseGroupMbid)) return;
    const title = albumTitle || "album";
    setRequesting(true);
    try {
      if (libraryAlbum) {
        const result = await requestAlbumFromSearch({
          ...buildAurralAlbumRetryPayload({ album: libraryAlbum, artist: libraryArtist }),
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
      } else if (releaseGroupMbid) {
        const result = await requestAlbumFromSearch(
          buildAlbumRequestPayload({
            albumMbid: releaseGroupMbid,
            albumName: albumTitle,
            artistMbid,
            artistName,
            managedBy,
            triggerSearch,
          }),
        );
        await queryClient.invalidateQueries({
          queryKey: queryKeys.libraryAlbumLookup([releaseGroupMbid]),
        });
        const outcome = describeAlbumRequestResult(result, title);
        (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
      }
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
  };

  return { downloadAlbum, requesting, ownerConflict };
}
