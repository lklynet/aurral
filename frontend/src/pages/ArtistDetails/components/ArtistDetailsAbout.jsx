import { Fragment, useMemo } from "react";
import PropTypes from "prop-types";
import { ExternalLink } from "lucide-react";
import { getArtistHeroImage, getArtistType, getTagColor } from "../utils";
import lidarrLogo from "../../../../images/logos/lidarr.svg?raw";
import lastFmLogo from "../../../../images/logos/last-fm.svg?raw";
import musicBrainzLogo from "../../../../images/logos/musicbrainz.svg?raw";
import listenBrainzLogo from "../../../../images/logos/listenbrainz.svg?raw";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toCurrentColorSvg = (svg) =>
  svg
    .replace(/fill:#fff/gi, "fill:currentColor")
    .replace(/fill="#fff"/gi, 'fill="currentColor"')
    .replace(/fill:#ffffff/gi, "fill:currentColor")
    .replace(/fill="#ffffff"/gi, 'fill="currentColor"');

const normalizeHref = (value) => {
  const href = String(value || "").trim();
  if (!href) return null;
  try {
    return new URL(href).toString();
  } catch {
    return null;
  }
};

const hostnameLabel = (href) => {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
};

const buildTags = (artist) => {
  const seen = new Set();
  const out = [];
  const source = [
    ...(Array.isArray(artist?.genres) ? artist.genres : []),
    ...(Array.isArray(artist?.tags) ? artist.tags : []),
  ];
  for (const item of source) {
    const name = String(typeof item === "string" ? item : item?.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name });
  }
  return out;
};

const buildRelationLinks = (artist) => {
  const direct = Array.isArray(artist?.links) ? artist.links : [];
  const relationSource =
    direct.length > 0
      ? direct.map((link, index) => ({
          key: `link-${index}`,
          href: link?.target || link?.url,
          label: link?.type,
        }))
      : Array.isArray(artist?.relations)
        ? artist.relations.map((relation, index) => ({
            key: `relation-${index}`,
            href: relation?.url?.resource,
            label: relation?.type,
          }))
        : [];

  return relationSource
    .map((link) => {
      const href = normalizeHref(link.href);
      if (!href) return null;
      return {
        ...link,
        href,
        label: link.label || hostnameLabel(href),
      };
    })
    .filter(Boolean);
};

const tagSearchPath = (name) =>
  `/search?q=${encodeURIComponent(`#${name}`)}&type=tag`;

export function ArtistDetailsAbout({
  artist,
  libraryArtist,
  appSettings,
  existsInLibrary,
  coverImages,
  onNavigate,
}) {
  const tags = useMemo(() => buildTags(artist), [artist]);
  const visibleTags = tags.slice(0, 5);
  const artistTypeLabel = getArtistType(artist?.type);
  const links = useMemo(() => {
    const lidarrArtistId =
      artist?.id ||
      libraryArtist?.foreignArtistId ||
      libraryArtist?.mbid ||
      artist?._lidarrData?.foreignArtistId;
    const lidarrUrl =
      appSettings?.integrations?.lidarr?.externalUrl ||
      appSettings?.integrations?.lidarr?.url;
    const lidarrHref =
      lidarrUrl && lidarrArtistId
        ? `${lidarrUrl.replace(/\/$/, "")}/${
            existsInLibrary
              ? `artist/${lidarrArtistId}`
              : `add/search?term=lidarr:${encodeURIComponent(lidarrArtistId)}`
          }`
        : null;
    const primary = [
      lidarrHref
        ? {
            key: "lidarr",
            label: "Lidarr",
            href: lidarrHref,
            logo: toCurrentColorSvg(lidarrLogo),
            color: "#b3b3b3",
          }
        : null,
      artist?.name
        ? {
            key: "lastfm",
            label: "Last.fm",
            href: `https://www.last.fm/music/${encodeURIComponent(artist.name)}`,
            logo: toCurrentColorSvg(lastFmLogo),
            color: "#b3b3b3",
          }
        : null,
      artist?.id && UUID_REGEX.test(artist.id)
        ? {
            key: "musicbrainz",
            label: "MusicBrainz",
            href: `https://musicbrainz.org/artist/${artist.id}`,
            logo: toCurrentColorSvg(musicBrainzLogo),
            color: "#b3b3b3",
          }
        : null,
      artist?.id && UUID_REGEX.test(artist.id)
        ? {
            key: "listenbrainz",
            label: "ListenBrainz",
            href: `https://listenbrainz.org/artist/${encodeURIComponent(
              artist.id,
            )}/`,
            logo: toCurrentColorSvg(listenBrainzLogo),
            color: "#b3b3b3",
          }
        : null,
    ].filter(Boolean);
    const seen = new Set(primary.map((link) => link.href));
    const secondary = buildRelationLinks(artist).filter((link) => {
      if (seen.has(link.href)) return false;
      seen.add(link.href);
      return true;
    });
    return [...primary, ...secondary];
  }, [appSettings, artist, existsInLibrary, libraryArtist]);
  const aboutImage = useMemo(() => {
    return getArtistHeroImage(coverImages);
  }, [coverImages]);

  if (!artist?.bio && tags.length === 0 && links.length === 0) return null;

  return (
    <section className="artist-section">
      <h2 className="artist-section-title artist-section-title--large">About</h2>
      <div className="artist-about-grid">
        <div className="artist-about-card">
          {aboutImage ? (
            <img
              src={aboutImage}
              alt=""
              className="artist-about-card__image"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="artist-about-card__fallback" />
          )}
          <div className="artist-about-card__wash" />

          {artist?.rating?.value != null && (
            <div className="artist-rating-badge">
              <span className="artist-rating-badge__value">
                {Number(artist.rating.value).toFixed(1)}
              </span>
              <span className="artist-rating-badge__label">
                Rating
              </span>
            </div>
          )}

          <div className="artist-about-card__body">
            <div className="artist-about-meta">
              {artistTypeLabel && <span>{artistTypeLabel}</span>}
              {artist?.disambiguation && <span>{artist.disambiguation}</span>}
              {visibleTags.length > 0 && (
                <span className="artist-about-meta__tags">
                  {visibleTags.map((tag, index) => (
                    <Fragment key={tag.key}>
                      {index > 0 ? (
                        <span aria-hidden="true"> · </span>
                      ) : null}
                      <button
                        type="button"
                        className="artist-about-meta__tag"
                        onClick={() => onNavigate?.(tagSearchPath(tag.name))}
                        title={`View artists with tag: ${tag.name}`}
                      >
                        {tag.name}
                      </button>
                    </Fragment>
                  ))}
                </span>
              )}
            </div>
            {artist?.bio ? (
              <p className="artist-about-bio">
                {artist.bio}
              </p>
            ) : (
              <p className="artist-modal__subcopy">
                No biography available.
              </p>
            )}
          </div>
        </div>

        <aside className="artist-about-aside">
          {tags.length > 0 && (
            <div>
              <h3 className="artist-about-side-title">Tags</h3>
              <div className="artist-tag-list">
                {tags.slice(0, 14).map((tag) => (
                  <button
                    key={tag.key}
                    type="button"
                    onClick={() => onNavigate?.(tagSearchPath(tag.name))}
                    className="artist-tag"
                    style={{ backgroundColor: getTagColor(tag.name) }}
                    title={`View artists with tag: ${tag.name}`}
                  >
                    #{tag.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {links.length > 0 && (
            <div>
              <h3 className="artist-about-side-title">Links</h3>
              <div className="artist-external-links">
                {links.slice(0, 10).map((link) => (
                  <a
                    key={`${link.key}-${link.href}`}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="artist-external-link"
                  >
                    {link.logo ? (
                      <span
                        className="artist-external-link__logo"
                        style={{ color: link.color || "#b3b3b3" }}
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: link.logo }}
                      />
                    ) : (
                      <ExternalLink className="artist-icon-sm" />
                    )}
                    <span className="artist-truncate">{link.label}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

ArtistDetailsAbout.propTypes = {
  artist: PropTypes.object.isRequired,
  libraryArtist: PropTypes.object,
  appSettings: PropTypes.object,
  existsInLibrary: PropTypes.bool,
  coverImages: PropTypes.array,
  onNavigate: PropTypes.func,
};
