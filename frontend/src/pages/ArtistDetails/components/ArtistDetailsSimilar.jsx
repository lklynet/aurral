import { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Loader, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";
import ArtistImage from "../../../components/ArtistImage";
import {
  lookupArtistsInLibraryBatch,
  readLibraryLookupCache,
} from "../../../utils/api";

const getArtistId = (artist) =>
  artist?.id || artist?.mbid || artist?.foreignArtistId;

export function ArtistDetailsSimilar({
  loadingSimilar,
  similarArtists,
  similarArtistsScrollRef,
  onArtistClick,
}) {
  const [libraryLookup, setLibraryLookup] = useState({});
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const artistIds = useMemo(
    () => similarArtists.map(getArtistId).filter(Boolean),
    [similarArtists],
  );

  const updateScrollState = useCallback(() => {
    const node = similarArtistsScrollRef?.current;
    if (!node) return;
    const maxScrollLeft = Math.max(node.scrollWidth - node.clientWidth, 0);
    setCanScrollLeft(node.scrollLeft > 2);
    setCanScrollRight(node.scrollLeft < maxScrollLeft - 2);
  }, [similarArtistsScrollRef]);

  const scrollByAmount = useCallback(
    (direction) => {
      const node = similarArtistsScrollRef?.current;
      if (!node) return;
      const width = node.clientWidth;
      node.scrollBy({
        left: direction * Math.max(width * 0.85, 280),
        behavior: "smooth",
      });
    },
    [similarArtistsScrollRef],
  );

  useEffect(() => {
    const cached = readLibraryLookupCache(artistIds);
    setLibraryLookup(cached);
    const missing = artistIds.filter((id) => cached[id] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    const fetchLookup = async () => {
      try {
        const lookup = await lookupArtistsInLibraryBatch(missing);
        if (!cancelled && lookup) {
          setLibraryLookup((prev) => ({ ...prev, ...lookup }));
        }
      } catch {
        if (!cancelled) {
          setLibraryLookup((prev) => ({ ...prev }));
        }
      }
    };
    fetchLookup();
    return () => {
      cancelled = true;
    };
  }, [artistIds]);

  useEffect(() => {
    const node = similarArtistsScrollRef?.current;
    if (!node) return;
    updateScrollState();
    node.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    return () => {
      node.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [similarArtists, similarArtistsScrollRef, updateScrollState]);

  if (!loadingSimilar && similarArtists.length === 0) return null;

  return (
    <section className="artist-section">
      <div className="artist-similar-header">
        <h2 className="artist-section-title">
          Fans Also Like
          {loadingSimilar && (
            <Loader
              className="artist-icon-sm animate-spin"
            />
          )}
        </h2>
        <div className="artist-scroll-controls">
          <button
            type="button"
            onClick={() => scrollByAmount(-1)}
            className="btn btn-ghost btn-icon-square"
            aria-label="Scroll similar artists left"
            disabled={!canScrollLeft}
          >
            <ChevronLeft className="artist-icon-lg" />
          </button>
          <button
            type="button"
            onClick={() => scrollByAmount(1)}
            className="btn btn-ghost btn-icon-square"
            aria-label="Scroll similar artists right"
            disabled={!canScrollRight}
          >
            <ChevronRight className="artist-icon-lg" />
          </button>
        </div>
      </div>
      {loadingSimilar ? (
        <div className="artist-loading">
          <Loader className="artist-spinner animate-spin" />
        </div>
      ) : similarArtists.length > 0 ? (
        <div>
          <div
            ref={similarArtistsScrollRef}
            className="artist-similar-rail similar-artists-scroll"
            style={{
              scrollbarWidth: "none",
              msOverflowStyle: "none",
            }}
          >
            {similarArtists.map((similar) => {
              const artistId = getArtistId(similar);
              return (
                <div
                  key={similar.id}
                  className="artist-similar-card"
                  onClick={() =>
                    onArtistClick(
                      similar.id,
                      similar.name,
                      typeof libraryLookup[artistId] === "boolean"
                        ? libraryLookup[artistId]
                        : undefined,
                    )
                  }
                >
                  <div
                    className="artist-similar-avatar"
                  >
                    <ArtistImage
                      src={similar.image}
                      mbid={similar.id}
                      artistName={similar.name}
                      alt={similar.name}
                      className=""
                    />

                    {similar.match && (
                      <div className="artist-similar-match">
                        {similar.match}% Match
                      </div>
                    )}
                  </div>
                  <div className="artist-similar-name-row">
                    <h3 className="artist-similar-name">
                      {similar.name}
                    </h3>
                    {artistId && libraryLookup[artistId] && (
                      <CheckCircle2 className="artist-library-check" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

ArtistDetailsSimilar.propTypes = {
  loadingSimilar: PropTypes.bool,
  similarArtists: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      name: PropTypes.string,
      image: PropTypes.string,
      match: PropTypes.number,
    })
  ),
  similarArtistsScrollRef: PropTypes.oneOfType([
    PropTypes.func,
    PropTypes.shape({ current: PropTypes.instanceOf(Element) }),
  ]),
  onArtistClick: PropTypes.func,
};
