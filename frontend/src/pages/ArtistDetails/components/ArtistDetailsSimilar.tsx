import { useEffect, useMemo, useState } from "react";
import { useShelfScroll } from "../hooks/useShelfScroll.ts";
import {
  lookupArtistsInLibraryBatch,
  readLibraryLookupCache,
  type ArtistsInLibrary,
} from "../../../utils/api/endpoints/library.ts";
import { getArtistFeedbackFlags } from "../../../utils/discoveryFeedback";
import { getArtistRecordId, type ArtistFeedbackAction } from "../../../utils/artistTaste";
import type { SimilarArtistsResponse } from "../../../utils/api/endpoints/artists.ts";

import { ChevronLeft, ChevronRight } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import ArtistImage from "../../../components/ArtistImage";
import { ArtistContextMenu } from "../../../components/ArtistContextMenu";
import TooltipButton from "../../../components/TooltipButton";
import RouteLink from "../../../components/RouteLink";

type SimilarArtist = SimilarArtistsResponse["artists"][number];

export function ArtistDetailsSimilar({
  loadingSimilar,
  similarArtists,
  onArtistFeedback,
  artistFeedbackLookup,
}: {
  loadingSimilar: boolean;
  similarArtists: SimilarArtist[];
  onArtistFeedback: (
    artist: SimilarArtist,
    action: ArtistFeedbackAction,
    options: { isSelected: boolean },
  ) => unknown;
  artistFeedbackLookup: Map<string, Set<string>> | null | undefined;
}) {
  const [libraryLookup, setLibraryLookup] = useState<ArtistsInLibrary>({});
  const artistIds = useMemo(
    () =>
      similarArtists
        .map((artist) => getArtistRecordId(artist))
        .filter((id): id is string => Boolean(id)),
    [similarArtists],
  );

  const shelf = useShelfScroll(similarArtists.length);
  const { canScrollLeft, canScrollRight } = shelf;

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

  if (!loadingSimilar && similarArtists.length === 0) return null;

  const canScroll = canScrollLeft || canScrollRight;

  return (
    <section className="artist-section">
      <div className="artist-section-head">
        <h2 className="artist-section-title">
          Fans also like
          {loadingSimilar && <DotLoader size="sm" label={null} />}
        </h2>
        {canScroll ? (
          <div className="artist-shelf-nav">
            <TooltipButton
              type="button"
              onClick={() => shelf.scrollBy(-1)}
              className="btn btn-ghost btn-icon-square"
              label="Scroll similar artists left"
              disabled={!canScrollLeft}
            >
              <ChevronLeft aria-hidden="true" />
            </TooltipButton>
            <TooltipButton
              type="button"
              onClick={() => shelf.scrollBy(1)}
              className="btn btn-ghost btn-icon-square"
              label="Scroll similar artists right"
              disabled={!canScrollRight}
            >
              <ChevronRight aria-hidden="true" />
            </TooltipButton>
          </div>
        ) : null}
      </div>
      {loadingSimilar ? (
        <div className="artist-loading">
          <DotLoader size="xl" label={null} />
        </div>
      ) : (
        <div ref={shelf.ref} className="artist-similar-rail">
          {similarArtists.map((similar) => {
            const artistId = getArtistRecordId(similar);
            const artistKey = String(artistId);
            const inLibrary = !!artistId && !!libraryLookup[artistKey];
            return (
              <div
                key={similar.id}
                className="artist-similar-card"
                data-artwork-scope
                data-library-menu-target
              >
                <div className="artist-similar-avatar" data-artwork>
                  <ArtistImage
                    src={similar.image}
                    mbid={artistId}
                    artistName={similar.name}
                    alt=""
                    className=""
                    loading="lazy"
                    enablePreviewPlayback
                    isInLibrary={inLibrary}
                  />
                </div>
                <h3 className="artist-similar-name">
                  <RouteLink
                    to={`/artist/${similar.id}`}
                    state={{
                      artistName: similar.name,
                      artistImage: similar.image || undefined,
                      ...(typeof libraryLookup[artistKey] === "boolean" && {
                        inLibrary: libraryLookup[artistKey],
                      }),
                    }}
                    className="card-link"
                  >
                    <span className="card-link__label">{similar.name}</span>
                  </RouteLink>
                </h3>
                <div className="artist-similar-row">
                  <p className="artist-similar-match">
                    {inLibrary ? <SearchLibraryCheck size="sm" /> : null}
                    {similar.match ? `${similar.match}% match` : inLibrary ? "In Library" : ""}
                  </p>
                  <ArtistContextMenu
                    artist={similar}
                    isInLibrary={inLibrary}
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
            );
          })}
        </div>
      )}
    </section>
  );
}
