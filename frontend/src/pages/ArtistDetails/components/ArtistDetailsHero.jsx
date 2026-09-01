import { useEffect, useMemo, useState } from "react";
import { getArtistHeroImage } from "../utils";
import { withImageCacheBust } from "../../../utils/normalizeMediaUrl";

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
  onCoverError,
  onNavigate,
}) {
  const heroImage = getArtistHeroImage(coverImages);
  const [imageFailed, setImageFailed] = useState(false);
  const [retryImage, setRetryImage] = useState("");
  const displayedImage = retryImage || heroImage;
  const tags = useMemo(() => buildTags(artist), [artist]);
  const visibleTags = tags.slice(0, 8);
  const showImage = displayedImage && !imageFailed;

  useEffect(() => {
    setImageFailed(false);
    setRetryImage("");
  }, [heroImage]);

  return (
    <section className="artist-hero">
      <div className="artist-hero__inner">
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
        ) : (
          <div className="artist-hero__fallback" />
        )}

        <div
          className={`artist-hero__content${showImage ? " artist-hero__content--overlay" : ""}`}
        >
          <h1 className="artist-hero__title">{artist.name}</h1>

          {visibleTags.length > 0 && (
            <div className="artist-tag-list">
              {visibleTags.map((tag) => (
                <button
                  key={tag.key}
                  type="button"
                  onClick={() =>
                    onNavigate?.(`/search?q=${encodeURIComponent(`#${tag.name}`)}&type=tag`)
                  }
                  className="artist-tag"
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
