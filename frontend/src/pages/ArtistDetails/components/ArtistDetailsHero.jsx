import { useMemo, useState } from "react";
import { getArtistHeroImage } from "../utils";

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
  const tags = useMemo(() => buildTags(artist), [artist]);
  const visibleTags = tags.slice(0, 8);
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
