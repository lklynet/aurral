import { Fragment, useMemo } from "react";
import { ExternalLink } from "../../../components/icons";
import { getArtistHeroImage, getArtistType, type ArtistCoverImage } from "../utils";
import type { ArtistDetailsResponse } from "../../../../../backend/routes/artists/handlers/details.ts";
import type { AppSettingsResponse } from "../../../utils/api/clients/settings.ts";
import type { LibraryArtistRecord } from "../hooks/useArtistDetailsStream.ts";
import lidarrLogo from "../../../../images/logos/lidarr-color.svg";
import lastFmLogo from "../../../../images/logos/last-fm-color.svg";
import musicBrainzLogo from "../../../../images/logos/musicbrainz-color.svg";
import listenBrainzLogo from "../../../../images/logos/listenbrainz-color.svg";

import { UUID_REGEX } from "../../../../../lib/uuid.ts";
import Tooltip from "../../../components/Tooltip";
import RouteLink from "../../../components/RouteLink";

const normalizeHref = (value: unknown) => {
  const href = String(value || "").trim();
  if (!href) return null;
  try {
    return new URL(href).toString();
  } catch {
    return null;
  }
};

const hostnameLabel = (href: string) => {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
};

const buildTags = (artist: Partial<ArtistDetailsResponse>) => {
  const seen = new Set<string>();
  const out: { key: string; name: string }[] = [];
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

type RelationLink = { key: string; label: string; href: string; logo?: string };

const buildRelationLinks = (artist: Partial<ArtistDetailsResponse>): RelationLink[] => {
  const direct = Array.isArray(artist?.links) ? artist.links : [];
  const relationSource =
    direct.length > 0
      ? direct.map((link, index) => ({
          key: `link-${index}`,
          href: link?.target,
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
    .filter((link) => link !== null);
};

const tagSearchPath = (name: string) => `/search?q=${encodeURIComponent(`#${name}`)}&type=tag`;

export function ArtistDetailsAbout({
  artist,
  libraryArtist,
  appSettings,
  lidarrConnected,
  existsInLibrary,
  coverImages,
}: {
  artist: Partial<ArtistDetailsResponse>;
  libraryArtist: LibraryArtistRecord | null;
  appSettings: AppSettingsResponse | null;
  lidarrConnected: boolean;
  existsInLibrary: boolean;
  coverImages: readonly ArtistCoverImage[] | null | undefined;
}) {
  const tags = useMemo(() => buildTags(artist), [artist]);
  const visibleTags = tags.slice(0, 5);
  const artistTypeLabel = getArtistType(artist?.type);
  const links = useMemo(() => {
    const lidarrArtistId = artist?.id || libraryArtist?.foreignArtistId || libraryArtist?.mbid;
    const lidarrUrl =
      appSettings?.integrations?.lidarr?.externalUrl || appSettings?.integrations?.lidarr?.url;
    const lidarrHref =
      lidarrConnected && lidarrUrl && lidarrArtistId
        ? `${lidarrUrl.replace(/\/$/, "")}/${
            existsInLibrary
              ? `artist/${lidarrArtistId}`
              : `add/search?term=lidarr:${encodeURIComponent(lidarrArtistId)}`
          }`
        : null;
    const primary: (RelationLink | null)[] = [
      lidarrHref
        ? {
            key: "lidarr",
            label: "Lidarr",
            href: lidarrHref,
            logo: lidarrLogo,
          }
        : null,
      artist?.name
        ? {
            key: "lastfm",
            label: "Last.fm",
            href: `https://www.last.fm/music/${encodeURIComponent(artist.name)}`,
            logo: lastFmLogo,
          }
        : null,
      artist?.id && UUID_REGEX.test(artist.id)
        ? {
            key: "musicbrainz",
            label: "MusicBrainz",
            href: `https://musicbrainz.org/artist/${artist.id}`,
            logo: musicBrainzLogo,
          }
        : null,
      artist?.id && UUID_REGEX.test(artist.id)
        ? {
            key: "listenbrainz",
            label: "ListenBrainz",
            href: `https://listenbrainz.org/artist/${encodeURIComponent(artist.id)}/`,
            logo: listenBrainzLogo,
          }
        : null,
    ];
    const primaryLinks = primary.filter((link) => link !== null);
    const seen = new Set(primaryLinks.map((link) => link.href));
    const secondary = buildRelationLinks(artist).filter((link) => {
      if (seen.has(link.href)) return false;
      seen.add(link.href);
      return true;
    });
    return [...primaryLinks, ...secondary];
  }, [appSettings, artist, existsInLibrary, libraryArtist, lidarrConnected]);
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
              <span className="artist-rating-badge__label">Rating</span>
            </div>
          )}

          <div
            className={`artist-about-card__body${aboutImage ? " artist-about-card__body--overlay" : ""}`}
          >
            <div className="artist-about-meta">
              {artistTypeLabel && <span>{artistTypeLabel}</span>}
              {artist?.disambiguation && <span>{artist.disambiguation}</span>}
              {visibleTags.length > 0 && (
                <span className="artist-about-meta__tags">
                  {visibleTags.map((tag, index) => (
                    <Fragment key={tag.key}>
                      {index > 0 ? <span aria-hidden="true"> · </span> : null}
                      <Tooltip content={`View artists with tag: ${tag.name}`}>
                        <RouteLink to={tagSearchPath(tag.name)} className="artist-about-meta__tag">
                          {tag.name}
                        </RouteLink>
                      </Tooltip>
                    </Fragment>
                  ))}
                </span>
              )}
            </div>
            {artist?.bio ? (
              <p className="artist-about-bio">{artist.bio}</p>
            ) : (
              <p className="artist-modal__subcopy">No biography available.</p>
            )}
          </div>
        </div>

        <aside className="artist-about-aside">
          {tags.length > 0 && (
            <div>
              <h3 className="artist-about-side-title">Tags</h3>
              <div className="artist-tag-list">
                {tags.slice(0, 14).map((tag) => (
                  <Tooltip key={tag.key} content={`View artists with tag: ${tag.name}`}>
                    <RouteLink to={tagSearchPath(tag.name)} className="artist-tag--discover">
                      #{tag.name}
                    </RouteLink>
                  </Tooltip>
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
                      <img
                        className="artist-external-link__logo"
                        src={link.logo}
                        alt=""
                        aria-hidden="true"
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
