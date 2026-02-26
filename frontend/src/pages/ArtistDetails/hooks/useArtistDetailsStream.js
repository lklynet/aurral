import { useState, useEffect, useRef, useCallback } from "react";
import {
  getArtistDetails,
  getArtistCover,
  lookupArtistInLibrary,
  getLibraryAlbums,
  getLibraryArtist,
  getSimilarArtistsForArtist,
  getAppSettings,
  getReleaseGroupCover,
} from "../../../utils/api";
import { emptyArtistShape } from "../constants";
import { useWebSocketChannel } from "../../../hooks/useWebSocket";

export function useArtistDetailsStream(mbid, artistNameFromNav) {
  const initialArtist =
    mbid && artistNameFromNav
      ? {
          id: mbid,
          name: artistNameFromNav,
          "sort-name": artistNameFromNav,
          ...emptyArtistShape,
          "release-groups": [],
        }
      : null;

  const [artist, setArtist] = useState(initialArtist);
  const [coverImages, setCoverImages] = useState([]);
  const [libraryArtist, setLibraryArtist] = useState(null);
  const [libraryAlbums, setLibraryAlbums] = useState([]);
  const [similarArtists, setSimilarArtists] = useState([]);
  const [loading, setLoading] = useState(!initialArtist);
  const [error, setError] = useState(null);
  const [existsInLibrary, setExistsInLibrary] = useState(false);
  const [loadingCover, setLoadingCover] = useState(true);
  const [loadingSimilar, setLoadingSimilar] = useState(true);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [appSettings, setAppSettings] = useState(null);
  const [albumCovers, setAlbumCovers] = useState({});
  const requestedAlbumCoversRef = useRef(new Set());
  const artistMbidRef = useRef(mbid);
  const libraryUpdatedRef = useRef(false);
  const libraryRefreshInFlightRef = useRef(false);
  const lastLibraryRefreshAtRef = useRef(0);
  const libraryLoadedRef = useRef(false);

  if (artistMbidRef.current !== mbid) {
    artistMbidRef.current = mbid;
    requestedAlbumCoversRef.current = new Set();
    libraryUpdatedRef.current = false;
    libraryRefreshInFlightRef.current = false;
    lastLibraryRefreshAtRef.current = 0;
    libraryLoadedRef.current = false;
  }

  const refreshLibrary = useCallback(
    async (force = false) => {
      if (!mbid) return;
      const now = Date.now();
      if (!force && now - lastLibraryRefreshAtRef.current < 1000) return;
      if (libraryRefreshInFlightRef.current) return;
      libraryRefreshInFlightRef.current = true;
      if (!libraryLoadedRef.current) {
        setLoadingLibrary(true);
      }
      try {
        const lookup = await lookupArtistInLibrary(mbid);
        setExistsInLibrary(lookup.exists);
        if (lookup.exists && lookup.artist) {
          const lookupMbid =
            lookup.artist.mbid || lookup.artist.foreignArtistId || null;
          const fullArtist = lookupMbid
            ? await getLibraryArtist(lookupMbid).catch(() => lookup.artist)
            : lookup.artist;
          setLibraryArtist(fullArtist);
          const artistId = fullArtist?.id || lookup.artist.id;
          if (artistId) {
            try {
              const albums = await getLibraryAlbums(artistId);
              setLibraryAlbums(albums);
            } catch {
              setTimeout(() => {
                getLibraryAlbums(artistId)
                  .then((albums) => setLibraryAlbums(albums))
                  .catch(() => {});
              }, 2000);
            }
          }
          libraryUpdatedRef.current = true;
        }
      } catch {}
      libraryRefreshInFlightRef.current = false;
      lastLibraryRefreshAtRef.current = Date.now();
      libraryLoadedRef.current = true;
      setLoadingLibrary(false);
    },
    [mbid],
  );

  useEffect(() => {
    if (!mbid) return;
    setLoading(true);
    setError(null);
    setLoadingCover(true);
    setLoadingSimilar(true);
    setLibraryArtist(null);
    setLibraryAlbums([]);
    setExistsInLibrary(false);
    setLoadingLibrary(true);
    libraryLoadedRef.current = false;

    getAppSettings()
      .then(setAppSettings)
      .catch(() => {});

    const API_BASE_URL = import.meta.env.VITE_API_URL || "/api";
    const password = localStorage.getItem("auth_password");
    const username = localStorage.getItem("auth_user") || "admin";

    let streamUrl = `${API_BASE_URL}/artists/${mbid}/stream`;
    const streamParams = [];
    if (password) {
      const token = btoa(`${username}:${password}`);
      streamParams.push(`token=${encodeURIComponent(token)}`);
    }
    if (artistNameFromNav) {
      streamParams.push(`artistName=${encodeURIComponent(artistNameFromNav)}`);
    }
    if (streamParams.length) streamUrl += `?${streamParams.join("&")}`;

    const eventSource = new EventSource(streamUrl);
    let artistReceived = false;
    let streamComplete = false;
    let coverReceived = false;
    let similarReceived = false;
    let libraryReceived = false;

    const fallbackTimeout = setTimeout(() => {
      if (!coverReceived) {
        const nameForCover = artistNameFromNav || artist?.name;
        getArtistCover(mbid, nameForCover)
          .then((coverData) => {
            if (coverData.images && coverData.images.length > 0) {
              setCoverImages(coverData.images);
            }
          })
          .catch(() => {})
          .finally(() => setLoadingCover(false));
      }
      if (!similarReceived) {
        getSimilarArtistsForArtist(mbid)
          .then((similarData) => {
            setSimilarArtists(similarData.artists || []);
          })
          .catch(() => {})
          .finally(() => setLoadingSimilar(false));
      }
    }, 10000);

    eventSource.addEventListener("connected", () => {});

    eventSource.addEventListener("artist", (event) => {
      try {
        const artistData = JSON.parse(event.data);
        if (!artistData || !artistData.id) {
          throw new Error("Invalid artist data received");
        }
        setArtist(artistData);
        setLoading(false);
        artistReceived = true;
      } catch (err) {
        console.error("Error parsing artist data:", err);
        setError("Failed to parse artist data");
        setLoading(false);
      }
    });

    eventSource.addEventListener("cover", (event) => {
      try {
        const coverData = JSON.parse(event.data);
        coverReceived = true;
        if (coverData.images && coverData.images.length > 0) {
          setCoverImages(coverData.images);
        }
        setLoadingCover(false);
      } catch (err) {
        console.error("Error parsing cover data:", err, event.data);
        setLoadingCover(false);
      }
    });

    eventSource.addEventListener("similar", (event) => {
      try {
        const similarData = JSON.parse(event.data);
        similarReceived = true;
        setSimilarArtists(similarData.artists || []);
        setLoadingSimilar(false);
      } catch (err) {
        console.error("Error parsing similar artists data:", err, event.data);
        setLoadingSimilar(false);
      }
    });

    eventSource.addEventListener("releaseGroupCover", (event) => {
      try {
        const coverData = JSON.parse(event.data);
        if (coverData.images && coverData.images.length > 0 && coverData.mbid) {
          const front =
            coverData.images.find((img) => img.front) || coverData.images[0];
          if (front && front.image) {
            setAlbumCovers((prev) => ({
              ...prev,
              [coverData.mbid]: front.image,
            }));
          }
        }
      } catch (err) {
        console.error(
          "Error parsing release group cover data:",
          err,
          event.data,
        );
      }
    });

    eventSource.addEventListener("library", (event) => {
      try {
        const data = JSON.parse(event.data);
        libraryReceived = true;
        libraryUpdatedRef.current = true;
        if (data.exists && data.artist) {
          setExistsInLibrary(true);
          setLibraryArtist(data.artist);
          setLibraryAlbums(data.albums || []);
        }
        setLoadingLibrary(false);
        libraryLoadedRef.current = true;
      } catch (err) {
        console.error("Error parsing library data:", err, event.data);
      }
    });

    eventSource.addEventListener("complete", () => {
      streamComplete = true;
      clearTimeout(fallbackTimeout);
      eventSource.close();

      if (libraryReceived || libraryUpdatedRef.current) {
        return;
      }
      refreshLibrary(true);
    });

    eventSource.addEventListener("error", (event) => {
      try {
        const errorData = JSON.parse(event.data);
        setError(
          errorData.message ||
            errorData.error ||
            "Failed to fetch artist details",
        );
        setLoading(false);
        eventSource.close();
      } catch {
        if (eventSource.readyState === EventSource.CLOSED) {
          eventSource.close();

          getArtistDetails(mbid, artistNameFromNav)
            .then((artistData) => {
              if (!artistData || !artistData.id) {
                throw new Error("Invalid artist data received");
              }
              setArtist(artistData);
              setLoading(false);

              const nameForCover = artistNameFromNav || artistData?.name;
              getArtistCover(mbid, nameForCover)
                .then((coverData) => {
                  if (coverData.images && coverData.images.length > 0) {
                    setCoverImages(coverData.images);
                  }
                })
                .catch(() => {})
                .finally(() => setLoadingCover(false));

              getSimilarArtistsForArtist(mbid)
                .then((similarData) => {
                  setSimilarArtists(similarData.artists || []);
                })
                .catch(() => {})
                .finally(() => setLoadingSimilar(false));
            })
            .catch((err) => {
              console.error("Error fetching artist data:", err);
              setError(
                err.response?.data?.message ||
                  err.response?.data?.error ||
                  err.message ||
                  "Failed to fetch artist details",
              );
              setLoading(false);
            });
        }
      }
    });

    eventSource.onerror = () => {
      if (!artistReceived && !streamComplete) {
        eventSource.close();

        getArtistDetails(mbid, artistNameFromNav)
          .then((artistData) => {
            if (!artistData || !artistData.id) {
              throw new Error("Invalid artist data received");
            }
            setArtist(artistData);
            setLoading(false);

            const nameForCover = artistNameFromNav || artistData?.name;
            getArtistCover(mbid, nameForCover)
              .then((coverData) => {
                if (coverData.images && coverData.images.length > 0) {
                  setCoverImages(coverData.images);
                }
              })
              .catch(() => {})
              .finally(() => setLoadingCover(false));

            getSimilarArtistsForArtist(mbid)
              .then((similarData) => {
                setSimilarArtists(similarData.artists || []);
              })
              .catch(() => {})
              .finally(() => setLoadingSimilar(false));
          })
          .catch((err) => {
            setError(
              err.response?.data?.message ||
                err.response?.data?.error ||
                err.message ||
                "Failed to fetch artist details",
            );
            setLoading(false);
          });
      }
    };

    return () => {
      clearTimeout(fallbackTimeout);
      eventSource.close();
    };
  }, [mbid, artistNameFromNav, artist?.name, refreshLibrary]);

  useWebSocketChannel("library", (msg) => {
    if (msg.type !== "library_update") return;
    const artistId = libraryArtist?.id;
    const matchMbid = msg.artistMbid && msg.artistMbid === mbid;
    const matchArtistId =
      artistId && msg.artistId && String(msg.artistId) === String(artistId);
    const matchAlbum =
      msg.albumId &&
      (libraryAlbums || []).some(
        (album) => String(album.id) === String(msg.albumId),
      );
    if (matchMbid || matchArtistId || matchAlbum) {
      refreshLibrary(true);
    }
  });

  useEffect(() => {
    if (!mbid) return;
    const releaseGroupIds =
      artist?.["release-groups"]?.map((rg) => rg.id).filter(Boolean) || [];
    const libraryMbids = (libraryAlbums || [])
      .map((a) => a.mbid || a.foreignAlbumId)
      .filter(Boolean);
    const needed = [...new Set([...releaseGroupIds, ...libraryMbids])];
    const missing = needed.filter(
      (id) => !albumCovers[id] && !requestedAlbumCoversRef.current.has(id),
    );
    missing.forEach((rgId) => {
      requestedAlbumCoversRef.current.add(rgId);
      getReleaseGroupCover(rgId)
        .then((data) => {
          if (data?.images?.length > 0) {
            const front =
              data.images.find((img) => img.front) || data.images[0];
            const url = front?.image;
            if (url) {
              setAlbumCovers((prev) => ({ ...prev, [rgId]: url }));
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          requestedAlbumCoversRef.current.delete(rgId);
        });
    });
  }, [mbid, artist, libraryAlbums, albumCovers]);

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
    existsInLibrary,
    setExistsInLibrary,
    appSettings,
    albumCovers,
    setAlbumCovers,
  };
}
