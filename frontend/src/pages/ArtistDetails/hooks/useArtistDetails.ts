import { useMemo } from "react";
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { artistsClient } from "../../../utils/api/clients/artists.ts";
import {
  artistSimilarQueryOptions,
  getArtistCover,
  type ArtistDetailsResponse,
} from "../../../utils/api/endpoints/artists.ts";
import { lookupArtistInLibrary } from "../../../utils/api/endpoints/library.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import { useWebSocketChannel } from "../../../hooks/useWebSocket.ts";
import { getApiErrorMessage } from "../../../utils/api/errors.ts";
import { allReleaseTypes, emptyArtistShape } from "../constants";
import type { ArtistCoverImage } from "../utils";

export type ArtistDetails = Partial<ArtistDetailsResponse>;
export type LibraryLookup = Awaited<ReturnType<typeof lookupArtistInLibrary>>;
export type LibraryAlbums = LibraryLookup["albums"];
export type LibraryAlbumEntry = LibraryAlbums[number];
export type OwnedAlbum = LibraryLookup["ownedAlbums"][number];

const APPEARS_ON_PAGE_SIZE = 24;
const SIMILAR_ARTIST_LIMIT = 10;
const EMPTY_LIBRARY_ALBUMS: LibraryAlbums = [];
const EMPTY_OWNED_ALBUMS: OwnedAlbum[] = [];
const EMPTY_SIMILAR_ARTISTS: never[] = [];

const artistCoverImagesOf = (
  cover: { images?: ArtistCoverImage[] } | undefined,
  seedImage: string | null,
): ArtistCoverImage[] =>
  cover?.images?.length ? cover.images : seedImage ? [{ image: seedImage, front: true }] : [];

export function useArtistDetails(
  mbid: string | undefined,
  artistNameFromNav: string | undefined,
  {
    inLibrary,
    seedImage = null,
    similar = false,
  }: { inLibrary?: boolean; seedImage?: string | null; similar?: boolean } = {},
) {
  const param = { mbid: encodeURIComponent(mbid ?? "") };
  const lookupKey = queryKeys.libraryLookupDetails(mbid);

  const detailsQuery = useQuery({
    queryKey: queryKeys.artistDetails(mbid, {
      releaseTypes: allReleaseTypes,
      appearsOnLimit: APPEARS_ON_PAGE_SIZE,
    }),
    queryFn: mbid
      ? async ({ signal }) => {
          const data = await parseResponse(
            artistsClient[":mbid"].$get(
              {
                param,
                query: {
                  artistName: artistNameFromNav || undefined,
                  releaseTypes: allReleaseTypes.join(","),
                  appearsOnLimit: String(APPEARS_ON_PAGE_SIZE),
                },
              },
              { init: { signal, cache: "no-cache" } },
            ),
          );
          queryClient.setQueryData(queryKeys.artistAppearsOn(mbid), {
            pages: [
              {
                items: data["appears-on-release-groups"] ?? [],
                offset: 0,
                hasMore: data["appears-on-has-more"] === true,
              },
            ],
            pageParams: [[] as string[]],
          });
          return data;
        }
      : skipToken,
    staleTime: 5 * 60_000,
  });

  const details = detailsQuery.data;
  const inlineCoverImages = details?.images ?? [];
  const inlineSimilar = details?.similar ?? [];
  const initialAppearsOn = useMemo(
    () =>
      details
        ? {
            pages: [
              {
                items: details["appears-on-release-groups"] ?? [],
                offset: 0,
                hasMore: details["appears-on-has-more"] === true,
              },
            ],
            pageParams: [[] as string[]],
          }
        : undefined,
    [details],
  );

  const appearsOnQuery = useInfiniteQuery({
    queryKey: queryKeys.artistAppearsOn(mbid),
    initialPageParam: [] as string[],
    queryFn: mbid
      ? ({ pageParam, signal }) =>
          parseResponse(
            artistsClient[":mbid"]["appears-on"].$post(
              {
                param,
                json: {
                  offset: pageParam.length,
                  limit: APPEARS_ON_PAGE_SIZE,
                  excludeIds: pageParam,
                },
              },
              { init: { signal } },
            ),
          )
      : skipToken,
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.hasMore && lastPage.items.length
        ? [...lastPageParam, ...lastPage.items.map(({ id }) => id)]
        : undefined,
    initialData: initialAppearsOn,
    initialDataUpdatedAt: detailsQuery.dataUpdatedAt || undefined,
    enabled: false,
    staleTime: 5 * 60_000,
  });

  const needsCoverFallback =
    Boolean(mbid) && detailsQuery.isSuccess && inlineCoverImages.length === 0;
  const coverQuery = useQuery({
    queryKey: queryKeys.artistCover(mbid),
    queryFn: mbid ? () => getArtistCover(mbid, details?.name || artistNameFromNav) : skipToken,
    enabled: needsCoverFallback,
    staleTime: Infinity,
  });

  const needsSimilarFallback =
    Boolean(mbid) && similar && detailsQuery.isSuccess && inlineSimilar.length === 0;
  const similarQuery = useQuery({
    ...artistSimilarQueryOptions(mbid ?? "", "", SIMILAR_ARTIST_LIMIT),
    enabled: needsSimilarFallback,
  });

  const libraryQuery = useQuery({
    queryKey: lookupKey,
    queryFn: mbid
      ? async ({ signal }) => {
          const lookup = await lookupArtistInLibrary(mbid, { signal });
          queryClient.setQueryData(queryKeys.libraryLookup(mbid), lookup.exists);
          return lookup;
        }
      : skipToken,
    staleTime: 15_000,
  });

  useWebSocketChannel(
    "library",
    (message) => {
      if (message?.type === "library_scan_completed") {
        void queryClient.invalidateQueries({ queryKey: lookupKey, exact: true });
      }
    },
    { enabled: Boolean(mbid) },
  );

  const appearsOnPages = appearsOnQuery.data?.pages;
  const artist = useMemo<ArtistDetails | null>(() => {
    if (!mbid) return null;
    const appearsOn =
      appearsOnPages?.flatMap((page) => page.items) ?? details?.["appears-on-release-groups"] ?? [];
    const name = details?.name || artistNameFromNav || "Loading artist";
    return {
      id: mbid,
      name,
      "sort-name": name,
      ...emptyArtistShape,
      "release-groups": [],
      ...details,
      "appears-on-release-groups": appearsOn,
    };
  }, [appearsOnPages, artistNameFromNav, details, mbid]);

  const lookup = libraryQuery.data;
  const libraryArtist = lookup?.exists ? lookup.artist : null;
  const detailsError = detailsQuery.isError && !details ? detailsQuery.error : null;
  const resolvedCover = coverQuery.data?.images?.length
    ? coverQuery.data
    : inlineCoverImages.length
      ? { images: inlineCoverImages }
      : undefined;

  return {
    artist,
    error: detailsError ? getApiErrorMessage(detailsError, "Failed to fetch artist details") : null,
    loadingReleases: detailsQuery.isPending,
    loadingAppearsOn: detailsQuery.isPending,
    appearsOn: appearsOnQuery,
    coverImages: artistCoverImagesOf(resolvedCover, seedImage),
    refreshCover: async () => {
      if (!mbid) return;
      const cover = await getArtistCover(mbid, details?.name || artistNameFromNav, true).catch(
        () => ({ images: [] }),
      );
      queryClient.setQueryData(queryKeys.artistCover(mbid), cover);
    },
    similarArtists:
      inlineSimilar.length > 0
        ? inlineSimilar
        : (similarQuery.data?.artists ?? EMPTY_SIMILAR_ARTISTS),
    loadingSimilar:
      similar && (detailsQuery.isPending || (needsSimilarFallback && similarQuery.isPending)),
    topTracks: details?.topTracks,
    existsInLibrary: lookup?.exists ?? inLibrary === true,
    loadingLibrary: libraryQuery.isPending && inLibrary === undefined,
    libraryArtist,
    libraryArtistId: lookup?.libraryArtistId ?? null,
    libraryAlbums: lookup?.exists ? lookup.albums : EMPTY_LIBRARY_ALBUMS,
    ownedAlbums: lookup?.ownedAlbums ?? EMPTY_OWNED_ALBUMS,
    refreshLibrary: () => queryClient.invalidateQueries({ queryKey: lookupKey, exact: true }),
  };
}
