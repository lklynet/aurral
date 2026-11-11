import { useMemo, useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getLibraryAlbums,
  getLibraryArtist,
  lookupArtistInLibrary,
  requestAlbumFromSearch,
} from "../../../utils/api/endpoints/library.ts";
import { describeAlbumRequestResult } from "../../../utils/albumAddAction.ts";
import {
  buildAurralAlbumRetryPayload,
  formatReleaseWait,
  isAwaitingRelease,
} from "../../../utils/aurralAlbumStatus.ts";
import {
  deduplicateAlbums,
  buildLibraryReleaseGroups,
  isLibraryAlbumComplete,
  ownedAlbumKey,
} from "../utils";
import { asApiError } from "../../../utils/api/core.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import type { LibraryArtistRecord, useArtistDetailsStream } from "./useArtistDetailsStream.ts";
import type { useToast } from "../../../contexts/ToastContext.tsx";
import { getApiErrorMessage, getApiErrorText } from "../../../utils/api/errors.ts";

type ArtistDetailsStream = ReturnType<typeof useArtistDetailsStream>;
export type ArtistDetailsLibrary = ReturnType<typeof useArtistDetailsLibrary>;
type ToastFn = ReturnType<typeof useToast>["showSuccess"];
export type LibraryAlbumId = string | number;
type LibraryAlbums = ArtistDetailsStream["libraryAlbums"];
export type LibraryAlbum = LibraryAlbums[number];

type ArtistDetailsLibraryOptions = Pick<
  ArtistDetailsStream,
  | "artist"
  | "libraryArtist"
  | "setLibraryArtist"
  | "libraryAlbums"
  | "setLibraryAlbums"
  | "existsInLibrary"
  | "setExistsInLibrary"
  | "ownedAlbums"
> & {
  showSuccess: ToastFn;
  showError: ToastFn;
  showInfo: ToastFn;
};

const invalidateLibraryQueries = (
  mbid: string | null = null,
  artistId: string | number | null = null,
) => {
  const queryKeysToInvalidate = [
    queryKeys.libraryPagePrefix,
    queryKeys.libraryViewPrefix,
    queryKeys.libraryAlbumsPrefix,
    queryKeys.libraryAlbumLookupPrefix,
  ];
  if (mbid) {
    queryKeysToInvalidate.push(
      queryKeys.libraryArtist(mbid),
      queryKeys.libraryLookup(mbid),
      queryKeys.libraryLookupDetails(mbid),
    );
  }
  if (artistId != null) queryKeysToInvalidate.push(queryKeys.libraryAlbums(artistId));
  return Promise.all(
    queryKeysToInvalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
};

export function useArtistDetailsLibrary({
  artist,
  libraryArtist,
  setLibraryArtist,
  libraryAlbums,
  setLibraryAlbums,
  existsInLibrary,
  setExistsInLibrary,
  ownedAlbums,
  showSuccess,
  showError,
  showInfo,
}: ArtistDetailsLibraryOptions) {
  const [requestingAlbum, setRequestingAlbum] = useState<string | null>(null);
  const [reSearchingMissingAlbums, setReSearchingMissingAlbums] = useState(false);
  const { isAlbumDownloading } = useActiveDownloads();
  const libraryAlbumsQueryKey = queryKeys.libraryAlbums(libraryArtist?.id);
  const libraryAlbumsQuery = useQuery<LibraryAlbums>({
    queryKey: libraryAlbumsQueryKey,
    queryFn: ({ signal }) => getLibraryAlbums(libraryArtist!.id!, { signal }),
    enabled: Boolean(libraryArtist?.id),
    initialData: libraryAlbums,
    initialDataUpdatedAt: 0,
    staleTime: 0,
  });
  const requestAlbumMutation = useMutation({
    mutationFn: requestAlbumFromSearch,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.libraryAlbumLookupPrefix }),
  });

  useEffect(() => {
    if (!libraryArtist?.id || !Array.isArray(libraryAlbumsQuery.data)) return;
    setLibraryAlbums(deduplicateAlbums(libraryAlbumsQuery.data));
  }, [libraryAlbumsQuery.data, libraryArtist?.id, setLibraryAlbums]);

  const reloadLibraryState = async () => {
    const mbid = artist?.id || libraryArtist?.mbid;
    if (!mbid) return;
    await invalidateLibraryQueries(mbid);
    const lookup = await lookupArtistInLibrary(mbid, { bypassCache: true });
    if (lookup.exists && lookup.artist) {
      await resolveLookupArtist(lookup.artist);
    } else {
      setExistsInLibrary(false);
      setLibraryArtist(null);
      setLibraryAlbums([]);
    }
  };

  const resolveLookupArtist = async (lookupArtist: LibraryArtistRecord | null) => {
    if (!lookupArtist) return null;
    const lookupMbid = lookupArtist.mbid || lookupArtist.foreignArtistId;
    let fullArtist: LibraryArtistRecord;
    try {
      fullArtist = await getLibraryArtist(lookupMbid, { bypassCache: true });
    } catch {
      fullArtist = {
        ...lookupArtist,
        foreignArtistId: lookupArtist.foreignArtistId || lookupArtist.mbid!,
      };
    }
    if (!fullArtist?.id) return null;
    setLibraryArtist(fullArtist);
    setExistsInLibrary(true);
    setLibraryAlbums(
      deduplicateAlbums(await getLibraryAlbums(fullArtist.id, { bypassCache: true })),
    );
    return fullArtist;
  };

  const handleRequestAlbum = async (albumId: string, title: string) => {
    if (requestingAlbum) return;
    setRequestingAlbum(albumId);
    try {
      if (!artist?.id || !artist?.name) {
        throw new Error("Artist information not available");
      }
      const artistMbid = artist.id;

      const result = await requestAlbumMutation.mutateAsync({
        albumMbid: albumId,
        albumName: title,
        artistMbid: artist.id,
        artistName: artist.name,
      });
      const addedArtist = result?.artist;
      const addedAlbum = result?.album;
      if (!addedArtist?.id || !addedAlbum?.id) {
        throw new Error("The album request did not complete");
      }
      const addedAlbumId = addedAlbum.id;
      const addedArtistId = addedArtist.id;

      setLibraryArtist((previous) => {
        const foreignArtistId = addedArtist.foreignArtistId || addedArtist.mbid || artistMbid;
        if (addedArtist.managedBy) {
          return { ...previous, ...addedArtist, id: addedArtistId, foreignArtistId };
        }
        return {
          ...previous,
          ...addedArtist,
          id: addedArtistId,
          managedBy: previous?.managedBy || null,
          foreignArtistId,
        };
      });
      setExistsInLibrary(true);
      setLibraryAlbums((previous) =>
        deduplicateAlbums([
          ...previous.filter(
            (album) =>
              album.id !== `pending-${albumId}` &&
              album.mbid !== albumId &&
              album.foreignAlbumId !== albumId,
          ),
          {
            ...addedAlbum,
            id: addedAlbumId,
            managedBy: "aurral",
            mbid: addedAlbum.mbid || addedAlbum.foreignAlbumId || albumId,
            foreignAlbumId: addedAlbum.foreignAlbumId || addedAlbum.mbid || albumId,
            monitored: true,
          },
        ]),
      );
      const outcome = describeAlbumRequestResult(result, title);
      (outcome.kind === "info" ? showInfo : showSuccess)(outcome.message);
    } catch (err) {
      showError(
        `Could not request ${title}. Nothing was added. ${getApiErrorMessage(err, "Try again.")}`,
      );
    } finally {
      setRequestingAlbum(null);
    }
  };

  const ownedByKey = useMemo(
    () => new Map(ownedAlbums.map((album) => [ownedAlbumKey(album), album])),
    [ownedAlbums],
  );

  const libraryReleaseGroups = useMemo(
    () =>
      buildLibraryReleaseGroups({
        releaseGroups: [
          ...(artist?.["release-groups"] ?? []),
          ...(artist?.["appears-on-release-groups"] ?? []),
        ],
        ownedAlbums,
        libraryAlbums,
        requestingAlbum,
      }),
    [artist, libraryAlbums, ownedAlbums, requestingAlbum],
  );

  const missingDownloads = libraryAlbums.filter((album) => {
    const albumId = String(album.id ?? "");
    if (!albumId || albumId.startsWith("pending-")) return false;
    if (album.managedBy !== "aurral") return false;
    if (isLibraryAlbumComplete(album)) return false;
    if (ownedByKey.has(album.mbid || album.foreignAlbumId || "")) return false;
    if (isAwaitingRelease({ ...album, trackFileCount: album.statistics?.trackFileCount })) {
      return false;
    }
    return album.monitored && !isAlbumDownloading(album.mbid || album.foreignAlbumId);
  });

  const handleReSearchMissingDownloads = async () => {
    setReSearchingMissingAlbums(true);
    try {
      const eligibleAlbums = missingDownloads;

      if (eligibleAlbums.length === 0) {
        showSuccess("No missing downloads to re-search.");
        return;
      }

      const results = await Promise.all(
        eligibleAlbums.map((album) =>
          requestAlbumFromSearch(
            buildAurralAlbumRetryPayload({
              album,
              artist: {
                mbid: album.artistMbid || libraryArtist?.foreignArtistId || libraryArtist?.mbid,
                name: album.artistName || libraryArtist?.artistName,
              },
            }),
          ),
        ),
      );
      const blockedAlbums = results.filter(
        (result) => result.status === "blocked" || result.albumStatus?.status === "blocked",
      );
      const searched = eligibleAlbums.length - blockedAlbums.length;
      if (searched === 0) {
        showInfo("Nothing is downloading. Open an album to see why.");
        return;
      }
      showSuccess(`Triggered search for ${searched} missing download${searched === 1 ? "" : "s"}`);
    } catch (err) {
      showError(
        `Failed to re-search missing downloads: ${getApiErrorText(err, "message") || asApiError(err)?.message}`,
      );
    } finally {
      setReSearchingMissingAlbums(false);
    }
  };

  const getAlbumStatus = (releaseGroupId: string) => {
    const owned = ownedByKey.get(releaseGroupId);
    const album =
      existsInLibrary && libraryArtist
        ? libraryAlbums.find(
            (a) => a.mbid === releaseGroupId || a.foreignAlbumId === releaseGroupId,
          )
        : undefined;
    if (album && isLibraryAlbumComplete(album)) {
      return {
        status: "available",
        label: "Complete",
        partial: (album.statistics?.percentOfTracks ?? 0) < 100,
      };
    }
    if (owned) return { status: "available", label: "Complete", partial: owned.partial };
    if (!album) return null;
    if (isAwaitingRelease({ ...album, trackFileCount: album.statistics?.trackFileCount })) {
      return { status: "waiting", label: formatReleaseWait(album.releaseDate) };
    }
    if (album.monitored) return { status: "monitored", label: "Monitored" };
    return { status: "unmonitored", label: "Not monitored" };
  };

  return {
    requestingAlbum,
    reloadLibraryState,
    reSearchingMissingAlbums,
    missingDownloadCount: missingDownloads.length,
    libraryReleaseGroups,
    handleRequestAlbum,
    handleReSearchMissingDownloads,
    getAlbumStatus,
  };
}
