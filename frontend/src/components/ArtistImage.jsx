import { useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import { Music, Loader } from "lucide-react";
import { getArtistCover } from "../utils/api";

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
  loading = "lazy",
}) => {
  const [currentSrc, setCurrentSrc] = useState(src);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const fetchingRef = useRef(false);
  const triedBackendFallbackRef = useRef(false);
  const imgRef = useRef(null);
  const abortRef = useRef(null);

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
                new Promise((_, reject) =>
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
            setCurrentSrc(url);
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
      setCurrentSrc(src);
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

  const showPlaceholder = !currentSrc;

  if (hasError) {
    return (
      <div className={`artist-image-placeholder ${className}`}>
        <Music className="artist-image-icon" />
      </div>
    );
  }

  if (showPlaceholder) {
    return (
      <div
        className={`artist-image-root ${className}`}
        style={{
          background:
            "linear-gradient(135deg, rgba(33,31,39,1) 0%, rgba(46,43,54,1) 100%)",
        }}
      >
        <div className="artist-image-overlay">
          {isLoading ? (
            <Loader
              className={`artist-image-loader${
                showLoading ? " animate-spin is-brand" : " is-dim"
              }`}
            />
          ) : (
            <Music className="artist-image-icon" />
          )}
        </div>
        {isLoading && <div className="artist-image-shimmer" />}
      </div>
    );
  }

  return (
    <div
      className={`artist-image-root ${className}`}
      style={{ backgroundColor: "#211f27" }}
    >
      {isLoading && showLoading && (
        <div
          className="artist-image-overlay"
          style={{ backgroundColor: "#211f27" }}
        >
          <Loader className="artist-image-loader animate-spin is-brand" />
        </div>
      )}
      {currentSrc && (
        <img
          ref={imgRef}
          src={currentSrc}
          alt={alt || "Artist cover"}
          className={`artist-image-media ${
            showLoading && isLoading ? "is-loading" : "is-loaded"
          }`}
          onLoad={handleLoad}
          onError={handleError}
          loading={loading}
          decoding="async"
        />
      )}
    </div>
  );
};

ArtistImage.propTypes = {
  mbid: PropTypes.string,
  src: PropTypes.string,
  alt: PropTypes.string,
  artistName: PropTypes.string,
  className: PropTypes.string,
  showLoading: PropTypes.bool,
  enableBackendFallback: PropTypes.bool,
  loading: PropTypes.oneOf(["eager", "lazy"]),
};

export default ArtistImage;
