import { useState } from "react";
import { useToast } from "../../contexts/ToastContext";
import { requestAlbumFromSearch } from "../../utils/api/endpoints/library.ts";
import { describeAlbumRequestResult } from "../../utils/albumAddAction.ts";
import { buildAurralAlbumRetryPayload } from "../../utils/aurralAlbumStatus.ts";
import type { LibraryAlbum, LibraryArtist } from "../../utils/libraryPageData.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";

export function useAlbumDownload({
  releaseGroupMbid,
  albumTitle,
  artistMbid,
  artistName,
  libraryAlbum,
  libraryArtist,
  onLibraryAlbumRequested,
}: {
  releaseGroupMbid: string | null;
  albumTitle: string;
  artistMbid: string | null;
  artistName: string;
  libraryAlbum: LibraryAlbum | null;
  libraryArtist: LibraryArtist | null | undefined;
  onLibraryAlbumRequested: () => Promise<void> | void;
}) {
  const { showError, showInfo, showSuccess } = useToast();
  const [requesting, setRequesting] = useState(false);
  const downloadAlbum = async () => {
    if (requesting || !(libraryAlbum || releaseGroupMbid)) return;
    const title = albumTitle || "album";
    setRequesting(true);
    try {
      if (libraryAlbum) {
        const result = await requestAlbumFromSearch(
          buildAurralAlbumRetryPayload({ album: libraryAlbum, artist: libraryArtist }),
        );
        const queued = result?.jobIds?.length || 0;
        showSuccess(
          queued > 0
            ? `Queued ${queued} ${queued === 1 ? "track" : "tracks"} from ${title}`
            : `Monitoring ${title}`,
        );
        await onLibraryAlbumRequested();
      } else if (releaseGroupMbid) {
        const result = await requestAlbumFromSearch({
          albumMbid: releaseGroupMbid,
          albumName: albumTitle,
          artistMbid,
          artistName,
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.libraryAlbumLookup([releaseGroupMbid]),
        });
        const outcome = describeAlbumRequestResult(result, title);
        (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
      }
    } catch (requestError) {
      showError(
        `Could not download ${albumTitle || "the album"}: ${getApiErrorMessage(
          requestError,
          "Try again.",
        )}`,
      );
    } finally {
      setRequesting(false);
    }
  };

  return { downloadAlbum, requesting };
}
