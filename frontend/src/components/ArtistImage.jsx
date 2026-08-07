import { useState, useEffect, useCallback, useRef } from "react";
import { getArtistCover } from "../utils/api/endpoints/artists.js";
import { normalizeMediaUrl } from "../utils/normalizeMediaUrl";
import { useArtistPreviewPlayback } from "../hooks/useArtistPreviewPlayback";

import { Music, Loader, Play } from "lucide-react";
const queue = [];
let active = 0;
const MAX_CONCURRENT = 4;

const processQueue = () => {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  const next = queue.shift();
  active++;
  next().finally(() => {
    active--;
    processQueue();
  });
};

const scheduleFetch = (fn, signal) => {
  return new Promise((resolve, reject) => {
    const entry = async () => {
      try {
        const res = await fn();
        resolve(res);
      } catch (err) {
        reject(err);
      }
    };
    queue.push(entry);

    if (signal) {
      signal.addEventListener("abort", () => {
        const idx = queue.indexOf(entry);
        if (idx !== -1) {
          queue.splice(idx, 1);
          reject(signal.reason || new DOMException("Aborted", "AbortError"));
        }
      });
    }

    processQueue();
  });
};

const ArtistImage = ({
  mbid,
  src,
  alt,
  artistName,
  className = "",
  showLoading = true,
  enableBackendFallback = true,
  enablePreviewPlayback = false,
  isInLibrary = false,
  loading = "lazy",
}) => {
  const [currentSrc, setCurrentSrc] = useState(() => normalizeMediaUrl(src));
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const fetchingRef = useRef(false);
  const triedBackendFallbackRef = useRef(false);
  const imgRef = useRef(null);
  const abortRef = useRef(null);
  const { canPlayArtistPreview, isArtistPreviewActive, isLoadingPreview, playArtistPreview } =
    useArtistPreviewPlayback({
      mbid,
      artistName,
      enabled: enablePreviewPlayback,
      isInLibrary,
    });

  const fetchBackendCover = useCallback(
    async (mbidToFetch, nameForCover, signal, refresh = false) => {
      if (!mbidToFetch || fetchingRef.current) {
        return;
      }

      fetchingRef.current = true;
      try {
        setHasError(false);

        const requestCover = (forceRefresh = false) =>
          scheduleFetch(
            () =>
              Promise.race([
                getArtistCover(mbidToFetch, nameForCover, forceRefresh),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000)),
              ]),
            signal,
          );

        let data = await requestCover(refresh);
        if (signal?.aborted) return;
        if ((!data?.images || data.images.length === 0) && !refresh) {
          data = await requestCover(true);
        }
        if (signal?.aborted) return;
        if (data?.images && data.images.length > 0) {
          const front = data.images.find((img) => img.front) || data.images[0];
          const url = front.image;
          if (url) {
            setCurrentSrc(normalizeMediaUrl(url));
            setHasError(false);
          } else {
            setHasError(true);
            setIsLoading(false);
          }
        } else {
          setHasError(true);
          setIsLoading(false);
        }
      } catch (err) {
        if (err?.name === "AbortError" || signal?.aborted) return;
        setHasError(true);
        setIsLoading(false);
      } finally {
        fetchingRef.current = false;
      }
    },
    [],
  );

  useEffect(() => {
    fetchingRef.current = false;
    triedBackendFallbackRef.current = false;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (src) {
      setCurrentSrc(normalizeMediaUrl(src));
      setHasError(false);
      setIsLoading(true);
    } else if (mbid && enableBackendFallback) {
      setCurrentSrc(null);
      setHasError(false);
      setIsLoading(true);
      fetchBackendCover(mbid, artistName, controller.signal);
    } else {
      setCurrentSrc(null);
      setIsLoading(false);
      setHasError(false);
    }

    return () => controller.abort();
  }, [src, mbid, artistName, fetchBackendCover, enableBackendFallback]);

  useEffect(() => {
    const image = imgRef.current;
    if (!currentSrc || !image) return;

    if (image.complete && image.naturalWidth > 0) {
      setIsLoading(false);
      setHasError(false);
      return;
    }

    let cancelled = false;
    if (typeof image.decode === "function") {
      image
        .decode()
        .then(() => {
          if (!cancelled) {
            setIsLoading(false);
            setHasError(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setIsLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
    };
  }, [currentSrc]);

  const handleLoad = () => {
    setIsLoading(false);
  };

  const handleError = () => {
    if (enableBackendFallback && mbid && !triedBackendFallbackRef.current) {
      triedBackendFallbackRef.current = true;
      setIsLoading(true);
      setHasError(false);
      fetchBackendCover(mbid, artistName, abortRef.current?.signal, true);
      return;
    }
    setHasError(true);
    setIsLoading(false);
  };

  const handlePreviewClick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await playArtistPreview();
  };

  const previewButton = canPlayArtistPreview ? (
    <span
      role="button"
      tabIndex={isLoadingPreview ? -1 : 0}
      className={`artist-image-preview-button${isArtistPreviewActive ? " is-active" : ""}${isLoadingPreview ? " is-loading" : ""}`}
      onClick={handlePreviewClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playArtistPreview(); } }}
      aria-disabled={isLoadingPreview}
      aria-label={`Play ${artistName || "artist"} top tracks`}
      title={`Play ${artistName || "artist"} top tracks`}
    >
      {isLoadingPreview ? (
        <Loader className="artist-image-preview-button__icon animate-spin" />
      ) : (
        <Play className="artist-image-preview-button__icon" fill="currentColor" />
      )}
    </span>
  ) : null;

  const showPlaceholder = !currentSrc;

  if (hasError) {
    return (
      <div className={`artist-image-placeholder ${className}`}>
        <Music className="artist-image-icon" />
        {previewButton}
      </div>
    );
  }

  if (showPlaceholder) {
    return (
      <div
        className={`artist-image-root ${className}`}
        style={{
          background: "var(--aurral-surface-raised)",
        }}
      >
        <div className="artist-image-overlay">
          {isLoading ? (
            <Loader
              className={`artist-image-loader${showLoading ? " animate-spin" : " is-dim"}`}
            />
          ) : (
            <Music className="artist-image-icon" />
          )}
        </div>
        {previewButton}
        {isLoading && <div className="artist-image-shimmer" />}
      </div>
    );
  }

  return (
    <div
      className={`artist-image-root ${className}`}
      style={{ backgroundColor: "var(--aurral-surface-raised)" }}
    >
      {isLoading && showLoading && (
        <div
          className="artist-image-overlay"
          style={{ backgroundColor: "var(--aurral-surface-raised)" }}
        >
          <Loader className="artist-image-loader animate-spin" />
        </div>
      )}
      {currentSrc && (
        <img
          ref={imgRef}
          src={currentSrc}
          alt={alt || "Artist cover"}
          className={`artist-image-media ${showLoading && isLoading ? "is-loading" : "is-loaded"}`}
          onLoad={handleLoad}
          onError={handleError}
          loading={loading}
          decoding="async"
        />
      )}
      {previewButton}
    </div>
  );
};

export default ArtistImage;
