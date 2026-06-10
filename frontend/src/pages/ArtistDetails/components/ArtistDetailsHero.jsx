import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { MapPin } from "lucide-react";
import {
  formatLifeSpan,
  getArtistHeroImage,
  getArtistType,
  getTagColor,
} from "../utils";

const normalizeTagName = (value) => String(value || "").trim();

const buildTags = (artist) => {
  const seen = new Set();
  const tags = [];
  const source = [
    ...(Array.isArray(artist?.genres) ? artist.genres : []),
    ...(Array.isArray(artist?.tags) ? artist.tags : []),
  ];
  for (const item of source) {
    const name = normalizeTagName(typeof item === "string" ? item : item?.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push({ key, name });
  }
  return tags;
};

export function ArtistDetailsHero({
  artist,
  coverImages,
  existsInLibrary,
  loadingLibrary,
  onCoverError,
  onNavigate,
}) {
  const heroImage = getArtistHeroImage(coverImages);
  const [imageFailed, setImageFailed] = useState(false);
  const tags = useMemo(() => buildTags(artist), [artist]);
  const visibleTags = tags.slice(0, 8);
  const artistType = getArtistType(artist?.type);
  const lifeSpan = formatLifeSpan(artist?.["life-span"]);
  const releaseCount = Number(artist?.["release-group-count"] || 0);
  const location = artist?.area?.name || artist?.country || "";
  const showImage = heroImage && !imageFailed;

  return (
    <section className="artist-hero">
      <div className="artist-hero__inner">
        {showImage ? (
          <>
            <img
              src={heroImage}
              alt=""
              className="artist-hero__image"
              loading="eager"
              decoding="async"
              onError={() => {
                setImageFailed(true);
                onCoverError?.();
              }}
            />
            <div className="artist-hero__wash" />
          </>
        ) : (
          <div className="artist-hero__fallback" />
        )}

        <div className="artist-hero__content">
          <h1 className="artist-hero__title">
            {artist.name}
          </h1>

          <div className="artist-meta-line">
            {artistType && <span>{artistType}</span>}
            {location && (
              <span className="artist-meta-line__item">
                <MapPin className="artist-meta-line__icon" />
                {location}
              </span>
            )}
            {lifeSpan && <span>{lifeSpan}</span>}
            {releaseCount > 0 && (
              <span>
                {releaseCount.toLocaleString()} release
                {releaseCount === 1 ? "" : "s"}
              </span>
            )}
            <span>
              {loadingLibrary
                ? "Checking library"
                : existsInLibrary
                  ? "In your library"
                  : "Not in library"}
            </span>
          </div>

          {visibleTags.length > 0 && (
            <div className="artist-tag-list">
              {visibleTags.map((tag) => (
                <button
                  key={tag.key}
                  type="button"
                  onClick={() =>
                    onNavigate?.(
                      `/search?q=${encodeURIComponent(`#${tag.name}`)}&type=tag`,
                    )
                  }
                  className="artist-tag"
                  style={{ backgroundColor: getTagColor(tag.name) }}
                  title={`View artists with tag: ${tag.name}`}
                >
                  #{tag.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

ArtistDetailsHero.propTypes = {
  artist: PropTypes.object.isRequired,
  coverImages: PropTypes.array,
  loadingCover: PropTypes.bool,
  existsInLibrary: PropTypes.bool,
  loadingLibrary: PropTypes.bool,
  onCoverError: PropTypes.func,
  onNavigate: PropTypes.func,
};
