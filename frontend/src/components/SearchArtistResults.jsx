import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import {
  Ban,
  CheckCircle2,
  EyeOff,
  Library,
  Loader2,
  MoreVertical,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import ArtistImage from "./ArtistImage";

function ArtistActionsMenu({
  artist,
  isInLibrary,
  isBlocked,
  canAddArtist,
  onAddToLibrary,
  onAddToBlocklist,
  onFeedback,
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showMenu]);

  const handleAction = async (event, type, fn) => {
    event.stopPropagation();
    if (!fn || pendingAction) return;
    setPendingAction(type);
    const success = await fn(artist);
    if (success) setShowMenu(false);
    setPendingAction(null);
  };

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setShowMenu((prev) => !prev);
        }}
        className="flex h-8 w-8 items-center justify-center hover:bg-white/10"
        style={{ color: "#c1c1c3" }}
        aria-label={`Artist options for ${artist.name}`}
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {showMenu && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-44 border border-white/10 py-1 shadow-xl"
          style={{ backgroundColor: "#2a2830" }}
          onClick={(event) => event.stopPropagation()}
        >
          {canAddArtist && (
            <button
              type="button"
              onClick={(event) => handleAction(event, "library", onAddToLibrary)}
              disabled={isInLibrary || !!pendingAction}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ color: "#fff" }}
            >
              {pendingAction === "library" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Library className="h-4 w-4" />
              )}
              {isInLibrary ? "In Library" : "Add to Library"}
            </button>
          )}
          <button
            type="button"
            onClick={(event) =>
              handleAction(event, "blocklist", onAddToBlocklist)
            }
            disabled={isBlocked || !!pendingAction}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: isBlocked ? "#c1c1c3" : "#fca5a5" }}
          >
            {pendingAction === "blocklist" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Ban className="h-4 w-4" />
            )}
            {isBlocked ? "In Blocklist" : "Blocklist Artist"}
          </button>
          {onFeedback && (
            <>
              <button
                type="button"
                onClick={(event) =>
                  handleAction(event, "more_like_this", (nextArtist) =>
                    onFeedback(nextArtist, "more_like_this"),
                  )
                }
                disabled={!!pendingAction}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: "#fff" }}
              >
                <ThumbsUp className="h-4 w-4" />
                More like this
              </button>
              <button
                type="button"
                onClick={(event) =>
                  handleAction(event, "less_like_this", (nextArtist) =>
                    onFeedback(nextArtist, "less_like_this"),
                  )
                }
                disabled={!!pendingAction}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: "#fff" }}
              >
                <ThumbsDown className="h-4 w-4" />
                Less like this
              </button>
              <button
                type="button"
                onClick={(event) =>
                  handleAction(event, "already_known", (nextArtist) =>
                    onFeedback(nextArtist, "already_known"),
                  )
                }
                disabled={!!pendingAction}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: "#fff" }}
              >
                <CheckCircle2 className="h-4 w-4" />
                Already know this
              </button>
              <button
                type="button"
                onClick={(event) =>
                  handleAction(event, "hide_for_now", (nextArtist) =>
                    onFeedback(nextArtist, "hide_for_now"),
                  )
                }
                disabled={!!pendingAction}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: "#fca5a5" }}
              >
                <EyeOff className="h-4 w-4" />
                Hide for now
              </button>
            </>
          )}
        </div>
      )}
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

  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {artists.map((artist, index) => {
        const artistId = getArtistId(artist);
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

        return (
          <div
            key={artistId || `artist-${index}`}
            className="group relative flex min-w-0 flex-col"
          >
            <div
              onClick={() =>
                navigate(`/artist/${artistId}`, {
                  state: {
                    artistName: artist.name,
                    ...(typeof libraryLookup[artistId] === "boolean"
                      ? { inLibrary: libraryLookup[artistId] }
                      : {}),
                  },
                })
              }
              className="relative mb-3 aspect-square cursor-pointer overflow-hidden shadow-sm transition-all group-hover:shadow-md"
              style={{ backgroundColor: "#211f27" }}
            >
              <ArtistImage
                src={artistImages[artistId] || artist.image || artist.imageUrl}
                mbid={artistId}
                artistName={artist.name}
                alt={artist.name}
                className="h-full w-full transition-transform duration-300 group-hover:scale-105"
                showLoading={false}
                enableBackendFallback={false}
              />
            </div>

            <div className="flex min-w-0 items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-w-0 items-center gap-2">
                  <h3
                    onClick={() =>
                    navigate(`/artist/${artistId}`, {
                      state: {
                        artistName: artist.name,
                        ...(typeof libraryLookup[artistId] === "boolean"
                          ? { inLibrary: libraryLookup[artistId] }
                          : {}),
                      },
                    })
                  }
                    className="truncate cursor-pointer font-semibold hover:underline"
                    style={{ color: "#fff" }}
                    title={artist.name}
                  >
                    {artist.name}
                  </h3>
                  {libraryLookup[artistId] && (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-400" />
                  )}
                </div>

                <div
                  className="flex min-w-0 flex-col text-sm"
                  style={{ color: "#c1c1c3" }}
                >
                  {artistMetaText && (
                    <p className="truncate" title={artistMetaText}>
                      {artistMetaText}
                    </p>
                  )}
                  {disambiguationLine && (
                    <p
                      className="truncate text-xs opacity-80"
                      title={disambiguationLine}
                    >
                      {disambiguationLine}
                    </p>
                  )}
                </div>
              </div>

              {(canAddArtist || onAddArtistToBlocklist || onArtistFeedback) && (
                <ArtistActionsMenu
                  artist={artist}
                  isInLibrary={!!libraryLookup[artistId]}
                  isBlocked={isArtistBlocked(artist)}
                  canAddArtist={canAddArtist}
                  onAddToLibrary={onAddArtistToLibrary}
                  onAddToBlocklist={onAddArtistToBlocklist}
                  onFeedback={onArtistFeedback}
                />
              )}
            </div>
          </div>
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
};

ArtistActionsMenu.propTypes = {
  artist: PropTypes.object.isRequired,
  isInLibrary: PropTypes.bool,
  isBlocked: PropTypes.bool,
  canAddArtist: PropTypes.bool,
  onAddToLibrary: PropTypes.func,
  onAddToBlocklist: PropTypes.func,
  onFeedback: PropTypes.func,
};

export default SearchArtistResults;
