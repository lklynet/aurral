import { useState, useEffect, useCallback, useRef, type MouseEvent } from "react";
import { getArtistCover } from "../utils/api/endpoints/artists.ts";
import { normalizeMediaUrl, withImageCacheBust } from "../utils/normalizeMediaUrl";
import { useArtistPreviewPlayback } from "../hooks/useArtistPreviewPlayback";

import { Music, Play } from "./icons";
import { DotLoader } from "./DotLoader";
import Tooltip from "./Tooltip";
import ArtworkImage from "./ArtworkImage";
const queue: (() => Promise<void>)[] = [];
let active = 0;
const MAX_CONCURRENT = 4;

const processQueue = () => {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  const next = queue.shift()!;
  active++;
  next().finally(() => {
    active--;
    processQueue();
  });
};

const scheduleFetch = <T,>(fn: () => Promise<T>, signal?: AbortSignal) => {
  return new Promise<T>((resolve, reject) => {
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

type ArtistImageProps = {
  mbid?: string | number | null;
  src?: string | null;
  alt?: string | null;
  artistName?: string | null;
  className?: string;
  showLoading?: boolean;
  enableBackendFallback?: boolean;
  enablePreviewPlayback?: boolean;
  isInLibrary?: boolean;
  loading?: "eager" | "lazy";
  thumbnail?: boolean;
  sizes?: string;
  onImageLoad?: (src: string | null | undefined) => void;
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
  thumbnail = true,
  sizes = "200px",
  onImageLoad,
}: ArtistImageProps) => {
  const [currentSrc, setCurrentSrc] = useState<string | null | undefined>(() =>
    normalizeMediaUrl(src),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [fallbackVisible, setFallbackVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  const fetchingRef = useRef(false);
  const triedBackendFallbackRef = useRef(false);
  const failedSourceRef = useRef<string | null | undefined>(null);
  const visibleMbidRef = useRef<string | number | null | undefined>(fallbackVisible ? mbid : null);
  const imgRef = useRef<HTMLImageElement>(null);
  const fallbackTargetRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { canPlayArtistPreview, isArtistPreviewActive, isLoadingPreview, playArtistPreview } =
    useArtistPreviewPlayback({
      mbid,
      artistName,
      enabled: enablePreviewPlayback,
      isInLibrary,
    });

  const fetchBackendCover = useCallback(
    async (
      mbidToFetch: string | number,
      nameForCover: string | null | undefined,
      signal: AbortSignal | undefined,
      refresh = false,
    ) => {
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
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("Timeout")), 5000),
                ),
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
            const retryUrl =
              refresh && failedSourceRef.current === normalizeMediaUrl(url)
                ? withImageCacheBust(url)
                : url;
            setCurrentSrc(normalizeMediaUrl(retryUrl));
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
        if ((err instanceof Error && err.name === "AbortError") || signal?.aborted) return;
        setHasError(true);
        setIsLoading(false);
      } finally {
        fetchingRef.current = false;
      }
    },
    [],
  );

  useEffect(() => {
    const visible = typeof IntersectionObserver === "undefined";
    failedSourceRef.current = null;
    triedBackendFallbackRef.current = false;
    visibleMbidRef.current = visible ? mbid : null;
    setFallbackVisible(visible);
  }, [mbid, src]);

  useEffect(() => {
    if (currentSrc || !mbid || !enableBackendFallback) return;
    if (typeof IntersectionObserver === "undefined") {
      setFallbackVisible(true);
      return;
    }

    const target = fallbackTargetRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        visibleMbidRef.current = mbid;
        setFallbackVisible(true);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [currentSrc, enableBackendFallback, mbid, src]);

  useEffect(() => {
    fetchingRef.current = false;

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const normalizedSrc = normalizeMediaUrl(src);
    const sourceFailed = normalizedSrc && failedSourceRef.current === normalizedSrc;
    if (normalizedSrc && !sourceFailed) {
      setCurrentSrc(normalizedSrc);
      setHasError(false);
      setIsLoading(true);
    } else if (
      mbid &&
      enableBackendFallback &&
      fallbackVisible &&
      visibleMbidRef.current === mbid
    ) {
      setCurrentSrc(null);
      setHasError(false);
      setIsLoading(true);
      fetchBackendCover(mbid, artistName, controller.signal, Boolean(sourceFailed));
    } else {
      setCurrentSrc(null);
      setIsLoading(false);
      setHasError(false);
    }

    return () => controller.abort();
  }, [src, mbid, artistName, fetchBackendCover, enableBackendFallback, fallbackVisible]);

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
    onImageLoad?.(currentSrc);
  };

  const handleError = () => {
    if (enableBackendFallback && mbid && !triedBackendFallbackRef.current) {
      triedBackendFallbackRef.current = true;
      failedSourceRef.current = currentSrc;
      setCurrentSrc(null);
      setHasError(false);
      if (fallbackVisible && visibleMbidRef.current === mbid) {
        setIsLoading(true);
        fetchBackendCover(mbid, artistName, abortRef.current?.signal, true);
      } else {
        setIsLoading(false);
      }
      return;
    }
    setHasError(true);
    setIsLoading(false);
  };

  const handlePreviewClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    await playArtistPreview();
  };

  const previewButton = canPlayArtistPreview ? (
    <Tooltip content={`Play ${artistName || "artist"} top tracks`}>
      <button
        type="button"
        tabIndex={isLoadingPreview ? -1 : undefined}
        className={`artist-image-preview-button${isArtistPreviewActive ? " is-active" : ""}${isLoadingPreview ? " is-loading" : ""}`}
        onClick={handlePreviewClick}
        aria-disabled={isLoadingPreview}
        aria-label={`Play ${artistName || "artist"} top tracks`}
      >
        {isLoadingPreview ? (
          <DotLoader size="md" label={null} className="artist-image-preview-button__icon" />
        ) : (
          <Play className="artist-image-preview-button__icon" />
        )}
      </button>
    </Tooltip>
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
        ref={fallbackTargetRef}
        className={`artist-image-root ${className}`}
        style={{
          background: "var(--aurral-surface-raised)",
        }}
      >
        <div className="artist-image-overlay">
          {isLoading ? (
            <DotLoader
              size="md"
              label={null}
              className={`artist-image-loader${showLoading ? "" : " is-dim"}`}
            />
          ) : (
            <Music className="artist-image-icon" />
          )}
        </div>
        {previewButton}
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
          <DotLoader size="md" label={null} className="artist-image-loader" />
        </div>
      )}
      {currentSrc && (
        <ArtworkImage
          ref={imgRef}
          src={currentSrc}
          thumbnail={thumbnail}
          sizes={sizes}
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
