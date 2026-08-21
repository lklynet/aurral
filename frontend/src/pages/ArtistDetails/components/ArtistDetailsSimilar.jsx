import { useCallback, useEffect, useMemo, useState } from "react";
import { lookupArtistsInLibraryBatch, readLibraryLookupCache } from "../../../utils/api/endpoints/library.js";
import { getArtistFeedbackFlags } from "../../../utils/discoveryFeedback";
import { getArtistRecordId } from "../../../utils/artistTaste";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import ArtistImage from "../../../components/ArtistImage";
import { ArtistContextMenu } from "../../../components/ArtistContextMenu";
export function ArtistDetailsSimilar({
  loadingSimilar,
  similarArtists,
  similarArtistsScrollRef,
  onArtistClick,
  canAddArtist = false,
  onAddToLibrary,
  onArtistFeedback,
  artistFeedbackLookup,
}) {
  const [libraryLookup, setLibraryLookup] = useState({});
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const artistIds = useMemo(
    () => similarArtists.map(getArtistRecordId).filter(Boolean),
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
          {loadingSimilar && <DotLoader size="sm" label={null} />}
        </h2>
        <div className="artist-scroll-controls">
          <button
            type="button"
            onClick={() => scrollByAmount(-1)}
            className="btn btn-ghost btn-icon-square"
            aria-label="Scroll similar artists left"
            title="Scroll similar artists left"
            disabled={!canScrollLeft}
          >
            <ChevronLeft className="artist-icon-lg" />
          </button>
          <button
            type="button"
            onClick={() => scrollByAmount(1)}
            className="btn btn-ghost btn-icon-square"
            aria-label="Scroll similar artists right"
            title="Scroll similar artists right"
            disabled={!canScrollRight}
          >
            <ChevronRight className="artist-icon-lg" />
          </button>
        </div>
      </div>
      {loadingSimilar ? (
        <div className="artist-loading">
          <DotLoader size="xl" label={null} />
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
              const artistId = getArtistRecordId(similar);
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
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onArtistClick(
                        similar.id,
                        similar.name,
                        typeof libraryLookup[artistId] === "boolean"
                          ? libraryLookup[artistId]
                          : undefined,
                      );
                    }
                  }}
                  tabIndex={0}
                  role="button"
                >
                  <div className="artist-similar-avatar">
                    <ArtistImage
                      src={similar.image}
                      mbid={getArtistRecordId(similar)}
                      artistName={similar.name}
                      alt={similar.name}
                      className=""
                      loading="eager"
                      enablePreviewPlayback
                      isInLibrary={!!libraryLookup[artistId]}
                    />

                    {similar.match && (
                      <div className="artist-similar-match">{similar.match}% Match</div>
                    )}
                  </div>
                  <div className="artist-similar-name-row">
                    <div className="artist-similar-name-block">
                      <h3 className="artist-similar-name">{similar.name}</h3>
                      {artistId && libraryLookup[artistId] && <SearchLibraryCheck size="sm" />}
                    </div>
                    <div onClick={(event) => event.stopPropagation()} role="none">
                      <ArtistContextMenu
                        artist={similar}
                        isInLibrary={!!libraryLookup[artistId]}
                        canAddArtist={canAddArtist}
                        onAddToLibrary={onAddToLibrary}
                        onFeedback={onArtistFeedback}
                        feedbackUsed={
                          artistFeedbackLookup
                            ? getArtistFeedbackFlags(artistFeedbackLookup, similar)
                            : undefined
                        }
                        buttonClassName="btn btn-icon-square artist-context-menu__trigger"
                      />
                    </div>
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
