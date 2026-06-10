import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import {
  Ban,
  CheckCircle2,
  EyeOff,
  Library,
  Loader2,
  MoreVertical,
  Star,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import ArtistImage from "./ArtistImage";
import {
  getArtistFeedbackFlags,
  getDiscoveryFeedbackLabel,
} from "../utils/discoveryFeedback";

const MAIN_CONTENT_PORTAL_SELECTOR = ".app-main-wrap";

const getMainContentPortalRoot = () =>
  document.querySelector(MAIN_CONTENT_PORTAL_SELECTOR);

function ArtistActionsMenu({
  artist,
  isInLibrary,
  isBlocked,
  canAddArtist,
  onAddToLibrary,
  onAddToBlocklist,
  onFeedback,
  feedbackUsed = {},
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const menuButtonRef = useRef(null);
  const menuRef = useRef(null);

  const estimateMenuHeight = useCallback(() => {
    let items = 1;
    if (canAddArtist) items += 1;
    if (onFeedback) items += 4;
    return items * 42 + 8;
  }, [canAddArtist, onFeedback]);

  const updateMenuPosition = useCallback(() => {
    const button = menuButtonRef.current;
    const portalRoot = getMainContentPortalRoot();
    if (!button || !portalRoot) return;
    const wrapRect = portalRoot.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const gap = 8;
    const menuHeight =
      menuRef.current?.offsetHeight || estimateMenuHeight();
    const spaceAbove = rect.top - wrapRect.top - gap;
    const spaceBelow = wrapRect.bottom - rect.bottom - gap;
    let placement = "above";
    if (spaceAbove < menuHeight && spaceBelow >= menuHeight) {
      placement = "below";
    } else if (spaceAbove < menuHeight && spaceBelow < menuHeight) {
      placement = spaceBelow > spaceAbove ? "below" : "above";
    }
    const top =
      placement === "below"
        ? rect.bottom - wrapRect.top + gap
        : rect.top - wrapRect.top - gap;
    const left = Math.max(rect.right - wrapRect.left - 176, 12);
    setMenuPosition((prev) => {
      if (
        prev &&
        prev.top === top &&
        prev.left === left &&
        prev.placement === placement
      ) {
        return prev;
      }
      return { top, left, placement };
    });
  }, [estimateMenuHeight]);

  useEffect(() => {
    if (!showMenu) {
      setMenuPosition(null);
      return;
    }
    updateMenuPosition();
    const scrollRoot = document.querySelector(".app-main");
    window.addEventListener("resize", updateMenuPosition);
    scrollRoot?.addEventListener("scroll", updateMenuPosition, { passive: true });
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      scrollRoot?.removeEventListener("scroll", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [showMenu, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!showMenu) return;
    updateMenuPosition();
  }, [showMenu, updateMenuPosition]);

  const handleAction = async (event, type, fn) => {
    event.stopPropagation();
    if (!fn || pendingAction) return;
    setPendingAction(type);
    const success = await fn(artist);
    if (success) setShowMenu(false);
    setPendingAction(null);
  };

  const handleFeedbackClick = async (event, action) => {
    event.stopPropagation();
    if (!onFeedback || pendingAction) return;
    setPendingAction(action);
    await onFeedback(artist, action, {
      isSelected: !!feedbackUsed[action],
    });
    setPendingAction(null);
  };

  return (
  <div style={{ position: "relative", flexShrink: 0 }}>
    <button
      ref={menuButtonRef}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        setShowMenu((prev) => !prev);
      }}
      className="btn btn-surface btn-icon-square"
      aria-label={`Artist options for ${artist.name}`}
    >
      <MoreVertical className="artist-icon-sm" />
    </button>
    {showMenu && menuPosition && getMainContentPortalRoot()
      ? createPortal(
          <div
            ref={menuRef}
            className={`artist-options-menu--discover${menuPosition.placement === "below" ? " is-below" : ""}`}
            style={{
              top: menuPosition.top,
              left: menuPosition.left,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {canAddArtist && (
              <button
                type="button"
                onClick={(event) => handleAction(event, "library", onAddToLibrary)}
                disabled={isInLibrary || !!pendingAction}
                className="artist-menu-item--discover"
              >
                <div className="artist-menu-item__main--discover">
                  {pendingAction === "library" ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : (
                    <Library className="artist-icon-sm" />
                  )}
                  {isInLibrary ? "In Library" : "Add to Library"}
                </div>
              </button>
            )}
            <button
              type="button"
              onClick={(event) =>
                handleAction(event, "blocklist", onAddToBlocklist)
              }
              disabled={isBlocked || !!pendingAction}
              className={`artist-menu-item--discover ${isBlocked ? "" : "artist-menu-item--danger"}`}
            >
              <div className="artist-menu-item__main--discover">
                {pendingAction === "blocklist" ? (
                  <Loader2 className="artist-icon-sm animate-spin" />
                ) : (
                  <Ban className="artist-icon-sm" />
                )}
                {isBlocked ? "In Blocklist" : "Blocklist Artist"}
              </div>
            </button>
            {onFeedback && (
              <>
                <button
                  type="button"
                  onClick={(event) =>
                    handleFeedbackClick(event, "more_like_this")
                  }
                  disabled={!!pendingAction}
                  className={`artist-menu-item--discover${feedbackUsed.more_like_this ? " is-selected" : ""}`}
                >
                  <div className="artist-menu-item__main--discover">
                    {pendingAction === "more_like_this" ? (
                      <Loader2 className="artist-icon-sm animate-spin" />
                    ) : (
                      <ThumbsUp className="artist-icon-sm" />
                    )}
                    {getDiscoveryFeedbackLabel("more_like_this")}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(event) =>
                    handleFeedbackClick(event, "less_like_this")
                  }
                  disabled={!!pendingAction}
                  className={`artist-menu-item--discover${feedbackUsed.less_like_this ? " is-selected" : ""}`}
                >
                  <div className="artist-menu-item__main--discover">
                    {pendingAction === "less_like_this" ? (
                      <Loader2 className="artist-icon-sm animate-spin" />
                    ) : (
                      <ThumbsDown className="artist-icon-sm" />
                    )}
                    {getDiscoveryFeedbackLabel("less_like_this")}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(event) =>
                    handleFeedbackClick(event, "already_known")
                  }
                  disabled={!!pendingAction}
                  className={`artist-menu-item--discover${feedbackUsed.already_known ? " is-selected" : ""}`}
                >
                  <div className="artist-menu-item__main--discover">
                    {pendingAction === "already_known" ? (
                      <Loader2 className="artist-icon-sm animate-spin" />
                    ) : (
                      <CheckCircle2 className="artist-icon-sm" />
                    )}
                    {getDiscoveryFeedbackLabel("already_known")}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(event) =>
                    handleFeedbackClick(event, "hide_for_now")
                  }
                  disabled={!!pendingAction}
                  className="artist-menu-item--discover artist-menu-item--danger"
                >
                  <div className="artist-menu-item__main--discover">
                    <EyeOff className="artist-icon-sm" />
                    Hide for now
                  </div>
                </button>
              </>
            )}
          </div>,
          getMainContentPortalRoot(),
        )
      : null}
  </div>
  );
}

function SearchArtistResults({
  artists,
  type,
  artistImages,
  libraryLookup,
  navigate,
  canAddArtist,
  blockedArtists,
  onAddArtistToLibrary,
  onAddArtistToBlocklist,
  onArtistFeedback,
  artistFeedbackLookup,
}) {
  const getArtistId = (artist) =>
    artist?.id || artist?.mbid || artist?.foreignArtistId;

  const formatLifeSpan = (artist) => {
    const begin =
      artist?.begin || artist?.["life-span"]?.begin || artist?.lifeSpan?.begin;
    if (!begin) return null;
    const ended =
      artist?.ended ??
      artist?.["life-span"]?.ended ??
      artist?.lifeSpan?.ended ??
      false;
    const end =
      artist?.end || artist?.["life-span"]?.end || artist?.lifeSpan?.end || null;
    const beginYear = String(begin).split("-")[0];
    if (ended && end) {
      const endYear = String(end).split("-")[0];
      return `${beginYear} - ${endYear}`;
    }
    return `${beginYear} - Present`;
  };

  const normalizeArtistType = (artist) => {
    const raw = artist?.artistType || artist?.type || null;
    if (!raw) return null;
    const types = {
      Person: "Solo Artist",
      Group: "Band",
      Orchestra: "Orchestra",
      Choir: "Choir",
      Character: "Character",
      Other: "Other",
    };
    return types[raw] || raw;
  };

  const normalizeArea = (artist) => {
    const value = artist?.area || artist?.area?.name || null;
    if (!value) return null;
    return String(value).trim() || null;
  };

  const isArtistBlocked = (artist) => {
    const artistId = String(getArtistId(artist) || "").trim().toLowerCase();
    const artistName = String(artist?.name || "").trim().toLowerCase();
    return (blockedArtists || []).some((entry) => {
      const entryMbid = String(entry?.mbid || "").trim().toLowerCase();
      const entryName = String(entry?.name || "").trim().toLowerCase();
      if (artistId && entryMbid && artistId === entryMbid) return true;
      if (artistName && entryName && artistName === entryName) return true;
      return false;
    });
  };

  const openArtist = (artist) => {
    const artistId = getArtistId(artist);
    navigate(`/artist/${artistId}`, {
      state: {
        artistName: artist.name,
        ...(typeof libraryLookup[artistId] === "boolean"
          ? { inLibrary: libraryLookup[artistId] }
          : {}),
      },
    });
  };

  return (
    <div className="artist-release-grid">
      {artists.map((artist, index) => {
        const artistId = getArtistId(artist);
        const isRecommendedTagResult =
          type === "tag" && artist.tagResultSource === "recommended";
        const artistTypeLabel = normalizeArtistType(artist);
        const lifeSpan = formatLifeSpan(artist);
        const area = normalizeArea(artist);
        const country = artist?.country ? String(artist.country).trim() : null;
        const disambiguation = artist?.disambiguation
          ? String(artist.disambiguation).trim()
          : null;
        const disambiguationLine = [
          artistTypeLabel,
          area || country,
          lifeSpan,
          disambiguation,
        ]
          .filter(Boolean)
          .join(" • ");
        const artistMetaText = [
          type === "recommended" &&
            artist.sourceArtist &&
            `Similar to ${artist.sourceArtist}`,
        ]
          .filter(Boolean)
          .join(" • ");
        const feedbackHandler =
          type === "tag" && artist.tagResultSource !== "recommended"
            ? undefined
            : onArtistFeedback;

        return (
          <article
            key={artistId || `artist-${index}`}
            className="artist-discover-card"
          >
            <div
              onClick={() => openArtist(artist)}
              className="artist-discover-card__cover"
            >
              <ArtistImage
                src={artistImages[artistId] || artist.image || artist.imageUrl}
                mbid={artistId}
                artistName={artist.name}
                alt={artist.name}
                className="artist-discover-card__image"
                showLoading={false}
                enableBackendFallback={false}
              />
              {isRecommendedTagResult && (
                <span className="search-tag-badge" aria-hidden="true">
                  <Star className="search-tag-badge__icon" />
                </span>
              )}
            </div>

            <div className="artist-discover-card__content">
              <div className="artist-discover-card__text">
                <div className="artist-card-title-row--discover">
                  <h3
                    onClick={() => openArtist(artist)}
                    className="artist-card-title--discover"
                    title={artist.name}
                  >
                    {artist.name}
                  </h3>
                  {libraryLookup[artistId] && (
                    <CheckCircle2 className="artist-library-check--discover" />
                  )}
                </div>
                {artistMetaText ? (
                  <p
                    className="artist-card-meta--discover"
                    title={artistMetaText}
                  >
                    {artistMetaText}
                  </p>
                ) : null}
                {disambiguationLine ? (
                  <p
                    className="artist-card-meta--discover"
                    title={disambiguationLine}
                  >
                    {disambiguationLine}
                  </p>
                ) : null}
              </div>

              {(canAddArtist || onAddArtistToBlocklist || onArtistFeedback) && (
                <ArtistActionsMenu
                  artist={artist}
                  isInLibrary={!!libraryLookup[artistId]}
                  isBlocked={isArtistBlocked(artist)}
                  canAddArtist={canAddArtist}
                  onAddToLibrary={onAddArtistToLibrary}
                  onAddToBlocklist={onAddArtistToBlocklist}
                  onFeedback={feedbackHandler}
                  feedbackUsed={
                    artistFeedbackLookup
                      ? getArtistFeedbackFlags(artistFeedbackLookup, artist)
                      : undefined
                  }
                />
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

SearchArtistResults.propTypes = {
  artists: PropTypes.arrayOf(PropTypes.object).isRequired,
  type: PropTypes.string,
  artistImages: PropTypes.object.isRequired,
  libraryLookup: PropTypes.object.isRequired,
  navigate: PropTypes.func.isRequired,
  canAddArtist: PropTypes.bool,
  blockedArtists: PropTypes.arrayOf(PropTypes.object),
  onAddArtistToLibrary: PropTypes.func,
  onAddArtistToBlocklist: PropTypes.func,
  onArtistFeedback: PropTypes.func,
  artistFeedbackLookup: PropTypes.instanceOf(Map),
};

ArtistActionsMenu.propTypes = {
  artist: PropTypes.object.isRequired,
  isInLibrary: PropTypes.bool,
  isBlocked: PropTypes.bool,
  canAddArtist: PropTypes.bool,
  onAddToLibrary: PropTypes.func,
  onAddToBlocklist: PropTypes.func,
  onFeedback: PropTypes.func,
  feedbackUsed: PropTypes.shape({
    more_like_this: PropTypes.bool,
    less_like_this: PropTypes.bool,
    already_known: PropTypes.bool,
  }),
};

export default SearchArtistResults;
