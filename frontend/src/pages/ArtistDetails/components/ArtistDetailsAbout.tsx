import { useCallback, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "../../../components/icons";
import TooltipButton from "../../../components/TooltipButton";
import { useModalDialog } from "../../../hooks/useModalDialog.ts";
import { buildArtistTags } from "../utils";
import type { ArtistDetailsResponse } from "../../../utils/api/endpoints/artists.ts";

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

type RelationLink = { key: string; label: string; href: string };

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

function ArtistBio({ name, bio }: { name: string; bio: string }) {
  const titleId = useId();
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { dialogRef, handleBackdropClick } = useModalDialog({ open, onClose: close });
  const bioRef = useCallback(
    (node: HTMLParagraphElement | null) => {
      if (!node || !bio) return;
      const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    },
    [bio],
  );

  return (
    <>
      <p ref={bioRef} className="artist-about-bio">
        {bio}
      </p>
      {clipped && (
        <button type="button" className="artist-about-bio-more" onClick={() => setOpen(true)}>
          Read more
        </button>
      )}
      {open &&
        createPortal(
          <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
            <section
              ref={dialogRef}
              className="artist-modal artist-bio-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
            >
              <div className="artist-modal__header">
                <h2 id={titleId} className="artist-modal__title">
                  {name ? `About ${name}` : "About"}
                </h2>
                <TooltipButton
                  className="btn btn-ghost btn-icon-square"
                  onClick={close}
                  label="Close"
                >
                  <X className="artist-icon-md" aria-hidden="true" />
                </TooltipButton>
              </div>
              <p className="artist-bio-modal__text">{bio}</p>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}

const TAG_LIMIT = 10;
const LINK_LIMIT = 5;

export function ArtistDetailsAbout({ artist }: { artist: Partial<ArtistDetailsResponse> }) {
  const [showAllLinks, setShowAllLinks] = useState(false);
  const tags = useMemo(() => buildArtistTags(artist).slice(0, TAG_LIMIT), [artist]);
  const links = useMemo(() => {
    const validId = artist?.id && UUID_REGEX.test(artist.id) ? artist.id : null;
    const primary: (RelationLink | null)[] = [
      artist?.name
        ? {
            key: "lastfm",
            label: "Last.fm",
            href: `https://www.last.fm/music/${encodeURIComponent(artist.name)}`,
          }
        : null,
      validId
        ? {
            key: "musicbrainz",
            label: "MusicBrainz",
            href: `https://musicbrainz.org/artist/${validId}`,
          }
        : null,
      validId
        ? {
            key: "listenbrainz",
            label: "ListenBrainz",
            href: `https://listenbrainz.org/artist/${encodeURIComponent(validId)}/`,
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
  }, [artist]);
  const rating = artist?.rating?.value != null ? Number(artist.rating.value) : null;
  const visibleLinks = showAllLinks ? links : links.slice(0, LINK_LIMIT);
  const hiddenLinkCount = links.length - visibleLinks.length;

  if (!artist?.bio && tags.length === 0 && links.length === 0) return null;

  return (
    <section className="artist-section">
      <h2 className="artist-section-title">About</h2>
      <div className="artist-about">
        <div className="artist-min-0">
          {artist?.bio ? (
            <ArtistBio name={artist.name || ""} bio={artist.bio} />
          ) : (
            <p className="artist-about-bio is-empty">No biography available.</p>
          )}
        </div>
        <dl className="artist-about-facts">
          {rating != null && Number.isFinite(rating) ? (
            <>
              <dt>Rating</dt>
              <dd>{rating.toFixed(1)} / 10</dd>
            </>
          ) : null}
          {tags.length > 0 ? (
            <>
              <dt>Tags</dt>
              <dd className="artist-about-facts__list">
                {tags.map((tag) => (
                  <Tooltip key={tag.key} content={`View artists with tag: ${tag.name}`}>
                    <RouteLink to={tagSearchPath(tag.name)}>{tag.name}</RouteLink>
                  </Tooltip>
                ))}
              </dd>
            </>
          ) : null}
          {links.length > 0 ? (
            <>
              <dt>Links</dt>
              <dd className="artist-about-facts__list">
                {visibleLinks.map((link) => (
                  <a
                    key={`${link.key}-${link.href}`}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.label}
                  </a>
                ))}
                {hiddenLinkCount > 0 ? (
                  <button
                    type="button"
                    className="artist-about-facts__more"
                    onClick={() => setShowAllLinks(true)}
                  >
                    {hiddenLinkCount} more
                  </button>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  );
}
