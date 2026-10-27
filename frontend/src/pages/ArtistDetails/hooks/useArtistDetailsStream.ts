import { useState, useEffect, useMemo, useRef } from "react";
import type { ArtistDetailsResponse } from "../../../../../backend/routes/artists/handlers/details.ts";
import type { SimilarArtistsResponse } from "../../../../../backend/routes/artists/handlers/similar.ts";
import { getApiErrorMessage, type ArtistCoverImage } from "../utils";
import {
  getArtistDetails,
  getArtistCover,
  getSimilarArtistsForArtist,
  getReleaseGroupCoversBatch,
} from "../../../utils/api/endpoints/artists.ts";
import {
  lookupArtistInLibrary,
  getLibraryAlbums,
  getLibraryArtist,
  readLibraryLookupCache,
  type AlbumRequestResult,
  type LibraryArtist,
} from "../../../utils/api/endpoints/library.ts";
import { parseResponse } from "hono/client";
import { settingsClient, type AppSettingsResponse } from "../../../utils/api/clients/settings.ts";
import { getStoredAuth } from "../../../utils/api/core.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import { useWebSocketChannel } from "../../../hooks/useWebSocket.ts";
import { allReleaseTypes, emptyArtistShape } from "../constants";

export type ArtistDetails = Partial<ArtistDetailsResponse>;
type ReleaseGroupList = NonNullable<ArtistDetails["appears-on-release-groups"]>;
type ReleaseGroup = NonNullable<ArtistDetails["release-groups"]>[number];
export type LibraryAlbumEntry = {
  id: string | number;
  canonicalId?: string | number;
  mbid?: string | null;
  foreignAlbumId?: string | null;
  albumName?: string | null;
  albumType?: string;
  releaseDate?: string | null;
  monitored: boolean;
  managedBy?: string | null;
  artistMbid?: string | null;
  artistName?: string | null;
  statistics: { trackFileCount?: number; sizeOnDisk: number; percentOfTracks: number };
};
export type LibraryAlbums = LibraryAlbumEntry[];
export type LookupArtist = NonNullable<Awaited<ReturnType<typeof lookupArtistInLibrary>>["artist"]>;
export type AddedLibraryArtist = NonNullable<AlbumRequestResult["artist"]>;
export type LibraryArtistRecord = LibraryArtist | LookupArtist | AddedLibraryArtist;

const buildReleaseGroupCoverRequest = (
  rgId: string,
  artist: ArtistDetails | null,
  libraryAlbums: LibraryAlbums | undefined,
  pageArtistName: string,
) => {
  const releaseGroup =
    artist?.["release-groups"]?.find((item: ReleaseGroup) => item?.id === rgId) ||
    artist?.["appears-on-release-groups"]?.find((item) => item?.id === rgId);
  const libraryAlbum = libraryAlbums?.find(
    (album) => (album.mbid || album.foreignAlbumId) === rgId,
  );
  const appearsOnArtist =
    releaseGroup?.["artist-credit"]?.[0]?.name ||
    releaseGroup?.["artist-credit"]?.[0]?.artist?.name ||
    "";
  return {
    mbid: rgId,
    artistName: appearsOnArtist || pageArtistName || "",
    albumTitle: releaseGroup?.title || libraryAlbum?.albumName || "",
  };
};

const buildInitialArtist = (
  mbid: string | undefined,
  artistNameFromNav: string | undefined,
): ArtistDetails | null =>
  mbid
    ? {
        id: mbid,
        name: artistNameFromNav || "Loading artist",
        "sort-name": artistNameFromNav || "Loading artist",
        ...emptyArtistShape,
        "release-groups": [],
        "appears-on-release-groups": [],
      }
    : null;

const EMPTY_ARRAY: never[] = [];
const RELEASE_TYPES_PARAM = allReleaseTypes.join(",");

const normalizePositiveLimit = (value: number | null | undefined) => {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const sortAppearsOnReleaseGroups = (items: ReleaseGroupList = []) =>
  [...items].sort((a, b) =>
    String(b["first-release-date"] || "").localeCompare(String(a["first-release-date"] || "")),
  );

const getAppearsOnCoverIds = (
  releaseGroups: ReleaseGroupList | undefined,
  limit: number | null,
) => {
  if (!limit || !releaseGroups?.length) return [];
  return sortAppearsOnReleaseGroups(releaseGroups)
    .slice(0, limit)
    .map((releaseGroup) => releaseGroup?.id)
    .filter(Boolean);
};

type ArtistDetailsStreamOptions = {
  visibleCoverIds?: string[];
  initialLibraryHint?: {
    existsInLibrary?: boolean;
    libraryArtist?: LibraryArtistRecord | null;
  } | null;
  appearsOnLimit?: number | null;
  seedImage?: string | null;
};

export function useArtistDetailsStream(
  mbid: string | undefined,
  artistNameFromNav: string | undefined,
  {
    visibleCoverIds = EMPTY_ARRAY,
    initialLibraryHint = null,
    appearsOnLimit = null,
    seedImage = null,
  }: ArtistDetailsStreamOptions = {},
) {
  const initialArtist = buildInitialArtist(mbid, artistNameFromNav);
  const normalizedAppearsOnLimit = normalizePositiveLimit(appearsOnLimit);
  const appearsOnLimitKey = normalizedAppearsOnLimit ? String(normalizedAppearsOnLimit) : "";
  const visibleCoverIdsKey = Array.isArray(visibleCoverIds)
    ? visibleCoverIds.filter(Boolean).join("\0")
    : "";
  const initialLibraryExists = initialLibraryHint?.existsInLibrary;
  const initialLibraryArtist = initialLibraryHint?.libraryArtist || null;
  const stableInitialLibraryHint = useMemo(
    () => ({
      existsInLibrary: initialLibraryExists,
      libraryArtist: initialLibraryArtist,
    }),
    [initialLibraryExists, initialLibraryArtist],
  );
  const cachedLookupMap = mbid ? readLibraryLookupCache([mbid]) : {};
  const cachedLookup = mbid ? cachedLookupMap?.[mbid] : undefined;
  const seededExistsInLibrary =
    stableInitialLibraryHint.existsInLibrary === true || cachedLookup === true ? true : undefined;
  const seededLibraryArtist =
    seededExistsInLibrary && stableInitialLibraryHint.libraryArtist
      ? stableInitialLibraryHint.libraryArtist
      : null;

  const [artist, setArtist] = useState<ArtistDetails | null>(initialArtist);
  const artistId = artist?.id;
  const artistName = artist?.name;
  const artistReleaseGroups = artist?.["release-groups"];
  const artistAppearsOnReleaseGroups = artist?.["appears-on-release-groups"];
  const seedCoverImages = seedImage ? [{ image: seedImage, front: true }] : EMPTY_ARRAY;
  const seedCoverImagesRef = useRef(seedCoverImages);
  seedCoverImagesRef.current = seedCoverImages;
  const [coverImages, setCoverImages] = useState<ArtistCoverImage[]>(seedCoverImages);
  const [libraryArtist, setLibraryArtist] = useState<LibraryArtistRecord | null>(
    seededLibraryArtist,
  );
  const [libraryAlbums, setLibraryAlbums] = useState<LibraryAlbums>([]);
  const [similarArtists, setSimilarArtists] = useState<SimilarArtistsResponse["artists"]>([]);
  const [loading, setLoading] = useState(!mbid);
  const [error, setError] = useState<string | null>(null);
  const [existsInLibrary, setExistsInLibrary] = useState(seededExistsInLibrary === true);
  const [loadingCover, setLoadingCover] = useState(true);
  const [loadingSimilar, setLoadingSimilar] = useState(true);
  const [loadingLibrary, setLoadingLibrary] = useState(seededExistsInLibrary === undefined);
  const [loadingReleases, setLoadingReleases] = useState(!!mbid);
  const [loadingAppearsOn, setLoadingAppearsOn] = useState(!!mbid);
  const [appSettings, setAppSettings] = useState<AppSettingsResponse | null>(null);
  const [albumCovers, setAlbumCovers] = useState<Record<string, string>>({});
  const [fulfilledCoverIds, setFulfilledCoverIds] = useState(() => new Set<string>());
  const albumCoversRef = useRef(albumCovers);
  const fulfilledCoverIdsRef = useRef(fulfilledCoverIds);
  const requestedAlbumCoversRef = useRef(new Set<string>());
  const pendingCoverIdsRef = useRef(new Set<string>());
  const coverBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const artistMbidRef = useRef(mbid);
  const artistRef = useRef(artist);
  const libraryAlbumsRef = useRef(libraryAlbums);
  const artistNameRef = useRef(artistNameFromNav || "");
  const visibleCoverIdsRef = useRef(visibleCoverIds);
  const streamRequestRef = useRef(0);
  const libraryRefreshRef = useRef<(() => Promise<void>) | null>(null);
  const optimisticLibraryLookupRef = useRef(false);

  useWebSocketChannel(
    "library",
    (message) => {
      if (message?.type !== "library_scan_completed") return;
      libraryRefreshRef.current?.();
    },
    { enabled: Boolean(mbid) },
  );

  if (artistMbidRef.current !== mbid) {
    artistMbidRef.current = mbid;
    requestedAlbumCoversRef.current = new Set();
    pendingCoverIdsRef.current = new Set();
  }

  useEffect(() => {
    albumCoversRef.current = albumCovers;
    fulfilledCoverIdsRef.current = fulfilledCoverIds;
    artistRef.current = artist;
    libraryAlbumsRef.current = libraryAlbums;
    visibleCoverIdsRef.current = visibleCoverIds;
  });

  useEffect(() => {
    if (artistNameFromNav) artistNameRef.current = artistNameFromNav;
  }, [artistNameFromNav]);

  useEffect(() => {
    if (artistName) artistNameRef.current = artistName;
  }, [artistName]);

  useEffect(() => {
    if (!mbid) return;
    const requestId = ++streamRequestRef.current;
    const isCurrentRequest = () => streamRequestRef.current === requestId;
    const nextCachedLookup = readLibraryLookupCache([mbid])?.[mbid];
    optimisticLibraryLookupRef.current = nextCachedLookup === true;
    const nextSeededExistsInLibrary =
      stableInitialLibraryHint.existsInLibrary === true || nextCachedLookup === true
        ? true
        : undefined;
    const nextSeededLibraryArtist =
      nextSeededExistsInLibrary && stableInitialLibraryHint.libraryArtist
        ? stableInitialLibraryHint.libraryArtist
        : null;
    setArtist(buildInitialArtist(mbid, artistNameFromNav));
    setCoverImages(seedCoverImagesRef.current);
    setAlbumCovers({});
    const emptyFulfilled = new Set<string>();
    setFulfilledCoverIds(emptyFulfilled);
    fulfilledCoverIdsRef.current = emptyFulfilled;
    pendingCoverIdsRef.current = new Set();
    setSimilarArtists([]);
    setLoading(!mbid);
    setError(null);
    setLoadingCover(true);
    setLoadingSimilar(true);
    setLoadingReleases(!!mbid);
    setLoadingAppearsOn(!!mbid);
    setLibraryArtist(nextSeededLibraryArtist);
    setLibraryAlbums([]);
    setExistsInLibrary(nextSeededExistsInLibrary === true);
    setLoadingLibrary(nextSeededExistsInLibrary === undefined);

    queryClient
      .fetchQuery({
        queryKey: queryKeys.appSettings,
        queryFn: ({ signal }) => parseResponse(settingsClient.$get({}, { init: { signal } })),
        staleTime: 30_000,
      })
      .then((settings) => {
        if (isCurrentRequest()) {
          setAppSettings(settings);
        }
      })
      .catch(() => {});

    const API_BASE_URL = import.meta.env.VITE_API_URL || "/api";
    const { token } = getStoredAuth();

    let streamUrl = `${API_BASE_URL}/artists/${mbid}/stream`;
    const streamParams = [];
    if (token) {
      streamParams.push(`token=${encodeURIComponent(token)}`);
    }
    if (artistNameFromNav) {
      streamParams.push(`artistName=${encodeURIComponent(artistNameFromNav)}`);
    }
    if (normalizedAppearsOnLimit) {
      streamParams.push(`appearsOnLimit=${encodeURIComponent(normalizedAppearsOnLimit)}`);
    }
    streamParams.push(`releaseTypes=${encodeURIComponent(RELEASE_TYPES_PARAM)}`);
    streamUrl += `?${streamParams.join("&")}`;

    const detailsMode = normalizedAppearsOnLimit ? "full" : "core";

    const eventSource = new EventSource(streamUrl);
    let artistReceived = false;
    let streamComplete = false;
    let coverReceived = false;
    let similarReceived = false;
    let libraryReceived = false;
    let restFallbackStarted = false;

    const loadCoverAndSimilarFallback = async (nameForCover: string, refreshCover = false) => {
      const requests = [];
      if (!coverReceived) {
        requests.push(
          getArtistCover(mbid, nameForCover, refreshCover)
            .then((coverData) => {
              if (!isCurrentRequest()) return;
              if (coverData.images && coverData.images.length > 0) {
                setCoverImages(coverData.images);
              }
            })
            .catch(() => {})
            .finally(() => {
              if (isCurrentRequest()) {
                setLoadingCover(false);
              }
            }),
        );
      }
      if (!similarReceived) {
        requests.push(
          getSimilarArtistsForArtist(mbid, nameForCover || "")
            .then((similarData) => {
              if (!isCurrentRequest()) return;
              setSimilarArtists(similarData.artists || []);
            })
            .catch(() => {})
            .finally(() => {
              if (isCurrentRequest()) {
                setLoadingSimilar(false);
              }
            }),
        );
      }
      await Promise.allSettled(requests);
    };

    const loadLibraryFallback = async ({ bypassCache = false } = {}) => {
      setLoadingLibrary(true);
      try {
        const lookup = await lookupArtistInLibrary(mbid, { bypassCache });
        if (!isCurrentRequest()) return;
        queryClient.setQueryData(queryKeys.libraryLookup(mbid), lookup.exists);
        setExistsInLibrary(lookup.exists);
        if (!lookup.exists || !lookup.artist) return;

        const fullArtist = lookup.canonical
          ? lookup.artist
          : await getLibraryArtist(lookup.artist.mbid || lookup.artist.foreignArtistId, {
              bypassCache,
            }).catch((err) => {
              console.error("Failed to fetch full artist details:", err);
              return lookup.artist;
            });
        if (!isCurrentRequest()) return;

        setLibraryArtist(fullArtist);

        if (lookup.canonical) {
          setLibraryAlbums(Array.isArray(lookup.albums) ? lookup.albums : []);
          return;
        }

        const artistId = fullArtist.id || lookup.artist.id;
        if (!artistId) return;

        const albums = await getLibraryAlbums(artistId, {
          bypassCache,
          managedBy: fullArtist.managedBy || lookup.artist.managedBy || null,
        }).catch((err) => {
          console.error("Failed to fetch library albums:", err);
          return [];
        });
        if (!isCurrentRequest()) return;
        setLibraryAlbums(albums);
      } catch {
      } finally {
        if (isCurrentRequest()) {
          setLoadingLibrary(false);
        }
      }
    };

    libraryRefreshRef.current = async () => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.libraryLookupDetails(mbid),
        exact: true,
      });
      return loadLibraryFallback({ bypassCache: true });
    };

    const loadRestFallback = async () => {
      if (restFallbackStarted) return;
      restFallbackStarted = true;
      clearTimeout(fallbackTimeout);
      eventSource.close();

      try {
        const artistData = await getArtistDetails(mbid, artistNameFromNav, {
          mode: detailsMode,
          releaseTypes: allReleaseTypes,
          appearsOnLimit: normalizedAppearsOnLimit ?? undefined,
        });
        if (!artistData || !artistData.id) {
          throw new Error("Invalid artist data received");
        }
        if (!isCurrentRequest()) return;
        setArtist(artistData);
        setLoading(false);
        setLoadingReleases(false);
        setLoadingAppearsOn(false);

        const nameForCover = artistData?.name || artistNameRef.current || artistNameFromNav || "";
        artistNameRef.current = nameForCover;
        await Promise.allSettled([
          loadCoverAndSimilarFallback(nameForCover),
          libraryReceived ? Promise.resolve() : loadLibraryFallback(),
        ]);
      } catch (err) {
        console.error("Error fetching artist data:", err);
        if (!isCurrentRequest()) return;
        setError(getApiErrorMessage(err) || "Failed to fetch artist details");
        setLoading(false);
        setLoadingCover(false);
        setLoadingSimilar(false);
        setLoadingLibrary(false);
        setLoadingReleases(false);
        setLoadingAppearsOn(false);
      }
    };

    const fallbackTimeout = setTimeout(() => {
      const nameForCover = artistNameRef.current || artistNameFromNav || "";
      loadCoverAndSimilarFallback(nameForCover).catch(() => {});
    }, 2500);

    eventSource.addEventListener("connected", () => {});

    eventSource.addEventListener("artist", (event) => {
      try {
        const artistData: ArtistDetails = JSON.parse(event.data);
        if (!isCurrentRequest()) return;
        if (!artistData) {
          throw new Error("Invalid artist data received");
        }
        if (!artistData.id && !artistReceived) {
          throw new Error("Invalid artist data received");
        }
        setArtist((prev) => {
          if (!prev) return artistData;
          const next = { ...prev, ...artistData };
          if (!("release-groups" in artistData)) {
            next["release-groups"] = prev["release-groups"];
          }
          if (!("appears-on-release-groups" in artistData)) {
            next["appears-on-release-groups"] = prev["appears-on-release-groups"];
          }
          if (!("release-group-count" in artistData)) {
            next["release-group-count"] = prev["release-group-count"];
          }
          if (!("release-count" in artistData)) {
            next["release-count"] = prev["release-count"];
          }
          if (!("tags" in artistData)) next.tags = prev.tags;
          if (!("genres" in artistData)) next.genres = prev.genres;
          if (!("bio" in artistData)) next.bio = prev.bio;
          return next;
        });
        if ("release-groups" in artistData && Array.isArray(artistData["release-groups"])) {
          setLoadingReleases(false);
        }
        if (
          "appears-on-release-groups" in artistData &&
          Array.isArray(artistData["appears-on-release-groups"])
        ) {
          setLoadingAppearsOn(false);
        }
        if (!artistReceived) setLoading(false);
        artistReceived = true;
      } catch (err) {
        console.error("Error parsing artist data:", err);
        if (!isCurrentRequest()) return;
        setError("Failed to parse artist data");
        setLoading(false);
      }
    });

    eventSource.addEventListener("cover", (event) => {
      try {
        const coverData: { images?: ArtistCoverImage[] } = JSON.parse(event.data);
        if (!isCurrentRequest()) return;
        coverReceived = true;
        if (coverData.images && coverData.images.length > 0) {
          setCoverImages(coverData.images);
        }
        setLoadingCover(false);
      } catch (err) {
        console.error("Error parsing cover data:", err, event.data);
        if (isCurrentRequest()) {
          setLoadingCover(false);
        }
      }
    });

    eventSource.addEventListener("similar", (event) => {
      try {
        const similarData: Partial<SimilarArtistsResponse> = JSON.parse(event.data);
        if (!isCurrentRequest()) return;
        similarReceived = true;
        setSimilarArtists(similarData.artists || []);
        setLoadingSimilar(false);
      } catch (err) {
        console.error("Error parsing similar artists data:", err, event.data);
        if (isCurrentRequest()) {
          setLoadingSimilar(false);
        }
      }
    });

    eventSource.addEventListener("library", (event) => {
      try {
        const data: Awaited<ReturnType<typeof lookupArtistInLibrary>> = JSON.parse(event.data);
        if (!isCurrentRequest()) return;
        libraryReceived = true;
        queryClient.setQueryData(queryKeys.libraryLookupDetails(mbid), data);
        if (data.exists && data.artist) {
          optimisticLibraryLookupRef.current = false;
          queryClient.setQueryData(queryKeys.libraryLookup(mbid), true);
          setExistsInLibrary(true);
          setLibraryArtist(data.artist);
          setLibraryAlbums(data.albums || []);
        } else if (!data.exists) {
          if (optimisticLibraryLookupRef.current) {
            setLoadingLibrary(false);
            return;
          }
          queryClient.setQueryData(queryKeys.libraryLookup(mbid), false);
          setExistsInLibrary(false);
          setLibraryArtist(null);
          setLibraryAlbums([]);
        }
        setLoadingLibrary(false);
      } catch (err) {
        console.error("Error parsing library data:", err, event.data);
      }
    });

    eventSource.addEventListener("complete", () => {
      if (!isCurrentRequest()) return;
      streamComplete = true;
      clearTimeout(fallbackTimeout);
      eventSource.close();
      setLoadingReleases(false);
      setLoadingAppearsOn(false);

      if (libraryReceived) {
        return;
      }

      loadLibraryFallback().catch(() => {});
    });

    eventSource.addEventListener("error", (event) => {
      try {
        const errorData: { message?: string; error?: string } = JSON.parse(
          event instanceof MessageEvent ? event.data : undefined,
        );
        if (!isCurrentRequest()) return;
        if (!artistReceived) {
          loadRestFallback().catch(() => {});
          return;
        }
        setError(errorData.message || errorData.error || "Failed to fetch artist details");
        setLoading(false);
        eventSource.close();
      } catch {
        if (isCurrentRequest() && eventSource.readyState === EventSource.CLOSED) {
          loadRestFallback().catch(() => {});
        }
      }
    });

    eventSource.onerror = () => {
      if (isCurrentRequest() && !artistReceived && !streamComplete) {
        loadRestFallback().catch(() => {});
      }
    };

    return () => {
      clearTimeout(fallbackTimeout);
      eventSource.close();
      libraryRefreshRef.current = null;
    };
  }, [
    mbid,
    artistNameFromNav,
    stableInitialLibraryHint,
    appearsOnLimitKey,
    normalizedAppearsOnLimit,
  ]);

  useEffect(() => {
    if (!artistId) return;
    const releaseGroups = [...(artistReleaseGroups || []), ...(artistAppearsOnReleaseGroups || [])];
    const seeded: Record<string, string> = {};
    for (const releaseGroup of releaseGroups) {
      const coverUrl = releaseGroup?.coverUrl || releaseGroup?._coverUrl;
      if (releaseGroup?.id && coverUrl) {
        seeded[releaseGroup.id] = coverUrl;
      }
    }
    if (!Object.keys(seeded).length) return;
    setAlbumCovers((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, url] of Object.entries(seeded)) {
        if (!next[id]) {
          next[id] = url;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setFulfilledCoverIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of Object.keys(seeded)) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [artistId, artistReleaseGroups, artistAppearsOnReleaseGroups]);

  useEffect(() => {
    if (!mbid) return undefined;

    let scheduleCancelled = false;

    const flushCoverBatch = async () => {
      const toFetch = [...pendingCoverIdsRef.current].filter(
        (id) =>
          !albumCoversRef.current[id] &&
          !fulfilledCoverIdsRef.current.has(id) &&
          !requestedAlbumCoversRef.current.has(id),
      );
      pendingCoverIdsRef.current.clear();
      if (!toFetch.length) {
        if (pendingCoverIdsRef.current.size > 0) {
          flushCoverBatch();
        }
        return;
      }

      const batchMbid = artistMbidRef.current;
      toFetch.forEach((id) => requestedAlbumCoversRef.current.add(id));

      const pageArtistName = artistNameRef.current || artistRef.current?.name || "";
      const items = toFetch.map((rgId) =>
        buildReleaseGroupCoverRequest(
          rgId,
          artistRef.current,
          libraryAlbumsRef.current,
          pageArtistName,
        ),
      );

      try {
        const covers = await getReleaseGroupCoversBatch(items);
        if (artistMbidRef.current !== batchMbid) return;
        const nextBatch: Record<string, string> = {};
        const resolvedIds: string[] = [];
        for (const rgId of toFetch) {
          const entry = covers?.[rgId];
          if (entry?.image) {
            nextBatch[rgId] = entry.image;
            resolvedIds.push(rgId);
          } else if (!entry?.transientError) {
            resolvedIds.push(rgId);
          }
        }
        if (Object.keys(nextBatch).length > 0) {
          setAlbumCovers((prev) => ({ ...prev, ...nextBatch }));
        }
        if (resolvedIds.length > 0) {
          setFulfilledCoverIds((prev) => {
            const next = new Set(prev);
            resolvedIds.forEach((id) => next.add(id));
            return next;
          });
        }
      } catch {
        if (artistMbidRef.current === batchMbid) {
          setFulfilledCoverIds((prev) => {
            const next = new Set(prev);
            toFetch.forEach((id) => next.delete(id));
            return next;
          });
        }
      } finally {
        toFetch.forEach((id) => requestedAlbumCoversRef.current.delete(id));
        if (artistMbidRef.current === batchMbid && pendingCoverIdsRef.current.size > 0) {
          flushCoverBatch();
        }
      }
    };

    const getEligibleVisibleCoverIds = () => {
      if (loadingReleases) {
        return [];
      }
      const fromVisible = [...new Set((visibleCoverIdsRef.current || []).filter(Boolean))];
      const appearsOnIds = !loadingAppearsOn
        ? getAppearsOnCoverIds(
            artistRef.current?.["appears-on-release-groups"],
            normalizedAppearsOnLimit,
          )
        : [];
      const visible = [...new Set([...fromVisible, ...appearsOnIds])];
      if (!visible.length) {
        return [];
      }
      if (!normalizedAppearsOnLimit || !loadingAppearsOn) {
        return visible;
      }
      const discographyIds = new Set(
        (artistRef.current?.["release-groups"] || [])
          .map((releaseGroup: ReleaseGroup) => releaseGroup?.id)
          .filter(Boolean),
      );
      const libraryIds = new Set(
        (libraryAlbumsRef.current || [])
          .map((album) => album.mbid || album.foreignAlbumId)
          .filter(Boolean),
      );
      return visible.filter((id) => discographyIds.has(id) || libraryIds.has(id));
    };

    const scheduleCoverBatch = () => {
      if (coverBatchTimerRef.current) clearTimeout(coverBatchTimerRef.current);
      coverBatchTimerRef.current = setTimeout(() => {
        if (scheduleCancelled) return;

        const eligible = getEligibleVisibleCoverIds();
        if (!eligible.length) return;

        const missing = eligible.filter(
          (id) =>
            !albumCoversRef.current[id] &&
            !fulfilledCoverIdsRef.current.has(id) &&
            !requestedAlbumCoversRef.current.has(id),
        );
        missing.forEach((id) => pendingCoverIdsRef.current.add(id));
        flushCoverBatch();
      }, 0);
    };

    scheduleCoverBatch();

    return () => {
      scheduleCancelled = true;
      if (coverBatchTimerRef.current) clearTimeout(coverBatchTimerRef.current);
    };
  }, [
    mbid,
    visibleCoverIdsKey,
    loadingReleases,
    loadingAppearsOn,
    normalizedAppearsOnLimit,
    artistAppearsOnReleaseGroups,
  ]);

  return {
    artist,
    setArtist,
    coverImages,
    setCoverImages,
    libraryArtist,
    setLibraryArtist,
    libraryAlbums,
    setLibraryAlbums,
    similarArtists,
    setSimilarArtists,
    loading,
    error,
    setError,
    loadingCover,
    setLoadingCover,
    loadingSimilar,
    setLoadingSimilar,
    loadingLibrary,
    setLoadingLibrary,
    loadingReleases,
    loadingAppearsOn,
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    albumCovers,
    setAlbumCovers,
    fulfilledCoverIds,
  };
}
