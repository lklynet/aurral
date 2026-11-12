import { useEffect, useMemo, useState } from "react";
import { buildArtistTags, getCoverImage, getArtistType, type ArtistCoverImage } from "../utils";
import type { ArtistDetailsResponse } from "../../../utils/api/endpoints/artists.ts";
import { withImageCacheBust } from "../../../utils/normalizeMediaUrl";
import { useSharedArtworkStyle } from "../../../navigation/viewTransitions.ts";

const HERO_GENRE_LIMIT = 3;

const buildFacts = (artist: Partial<ArtistDetailsResponse>) => {
  const genres = buildArtistTags(artist)
    .slice(0, HERO_GENRE_LIMIT)
    .map((tag) => tag.name.toLowerCase())
    .join(", ");
  return {
    lead: [getArtistType(artist.type), artist.disambiguation].filter(
      (fact): fact is string => !!fact,
    ),
    genres: genres ? genres.charAt(0).toUpperCase() + genres.slice(1) : "",
  };
};

export function ArtistDetailsHero({
  artist,
  coverImages,
  onCoverError,
}: {
  artist: Partial<ArtistDetailsResponse>;
  coverImages: readonly ArtistCoverImage[] | null | undefined;
  onCoverError?: () => void;
}) {
  const heroImage = getCoverImage(coverImages);
  const [imageFailed, setImageFailed] = useState(false);
  const [retryImage, setRetryImage] = useState("");
  const displayedImage = retryImage || heroImage;
  const facts = useMemo(() => buildFacts(artist), [artist]);
  const showImage = displayedImage && !imageFailed;
  const artworkStyle = useSharedArtworkStyle();

  useEffect(() => {
    setImageFailed(false);
    setRetryImage("");
  }, [heroImage]);

  return (
    <section className={`artist-hero${showImage ? "" : " artist-hero--plain"}`}>
      <div className="artist-hero__inner" style={artworkStyle}>
        {showImage ? (
          <>
            <img
              src={displayedImage}
              alt=""
              className="artist-hero__image"
              loading="eager"
              decoding="async"
              onError={() => {
                if (!retryImage && heroImage) {
                  setRetryImage(withImageCacheBust(heroImage));
                  return;
                } else {
                  setImageFailed(true);
                }
                onCoverError?.();
              }}
            />
            <div className="artist-hero__wash" />
          </>
        ) : null}

        <div className={`artist-hero__content${showImage ? " artist-hero__content--overlay" : ""}`}>
          <h1 className="artist-hero__title">{artist.name}</h1>

          {facts.lead.length > 0 || facts.genres ? (
            <p className="artist-hero__facts">
              {facts.lead.map((fact) => (
                <span key={fact}>{fact}</span>
              ))}
              {facts.genres ? <span className="artist-hero__genres">{facts.genres}</span> : null}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
