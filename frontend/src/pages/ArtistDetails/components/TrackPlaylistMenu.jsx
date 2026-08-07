import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader, Plus } from "lucide-react";
import AddActionButton from "../../../components/AddActionButton";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";

function normalizeTrackForSharedIdentity(track) {
  if (!track || typeof track !== "object" || Array.isArray(track)) {
    return null;
  }
  const artistName = String(
    track.artistName ?? track.artist ?? track.artist_name ?? track["Artist Name(s)"] ?? "",
  ).trim();
  const trackName = String(
    track.trackName ?? track.title ?? track.name ?? track.track ?? track["Track Name"] ?? "",
  ).trim();
  if (!artistName || !trackName) return null;
  const albumName = String(track.albumName ?? track.album ?? track["Album Name"] ?? "").trim();
  const artistMbid = String(track.artistMbid ?? track.artistId ?? "").trim();
  const albumMbid = String(track.albumMbid ?? track.releaseGroupMbid ?? track.albumId ?? "").trim();
  const trackMbid = String(
    track.trackMbid ?? track.recordingMbid ?? track.recordingId ?? track.mbid ?? "",
  ).trim();
  const releaseYear = String(track.releaseYear ?? track.year ?? "").trim();
  return {
    artistName,
    trackName,
    albumName,
    artistMbid,
    albumMbid,
    trackMbid,
    releaseYear,
  };
}

function buildSharedTrackIdentity(track) {
  const normalized = normalizeTrackForSharedIdentity(track);
  if (!normalized) return "";
  return [
    normalized.artistName.toLowerCase(),
    normalized.trackName.toLowerCase(),
    normalized.albumName.toLowerCase(),
    normalized.artistMbid,
    normalized.albumMbid,
    normalized.trackMbid,
    normalized.releaseYear,
  ].join("\u0001");
}

function buildCoreTrackIdentity(track) {
  const normalized = normalizeTrackForSharedIdentity(track);
  if (!normalized) return "";
  return `${normalized.artistName.toLowerCase()}\u0001${normalized.trackName.toLowerCase()}`;
}

function coreIdentityFromStoredIdentity(identity) {
  const parts = String(identity || "").split("\u0001");
  if (parts.length < 2) return "";
  return `${parts[0]}\u0001${parts[1]}`;
}

function trackMatchesStoredIdentity(storedIdentity, track) {
  const normalized = normalizeTrackForSharedIdentity(track);
  if (!normalized) return false;
  const targetFull = buildSharedTrackIdentity(track);
  if (targetFull && storedIdentity === targetFull) return true;
  const targetCore = buildCoreTrackIdentity(track);
  if (!targetCore) return false;
  return coreIdentityFromStoredIdentity(storedIdentity) === targetCore;
}

function playlistContainsTrack(playlist, track) {
  if (!track) return false;
  const identities = Array.isArray(playlist?.trackIdentities) ? playlist.trackIdentities : [];
  if (identities.length === 0) return false;
  return identities.some((identity) => trackMatchesStoredIdentity(identity, track));
}

function useAvailablePlaylists(playlists, excludedPlaylistIds) {
  return useMemo(() => {
    const excluded = new Set(
      (Array.isArray(excludedPlaylistIds) ? excludedPlaylistIds : [])
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    );
    return (Array.isArray(playlists) ? playlists : []).filter(
      (playlist) => !excluded.has(String(playlist?.id || "").trim()),
    );
  }, [excludedPlaylistIds, playlists]);
}

export function TrackPlaylistPickerContent({
  track = null,
  playlists = [],
  loading = false,
  saving = false,
  error = "",
  defaultNewPlaylistName = "Playlist",
  excludedPlaylistIds = [],
  onSelect,
}) {
  const availablePlaylists = useAvailablePlaylists(playlists, excludedPlaylistIds);

  if (loading) {
    return (
      <div className="artist-menu-item">
        <Loader className="artist-icon-sm animate-spin" />
        Loading playlists
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="artist-menu-item"
        onClick={() =>
          onSelect?.({
            mode: "new",
            name: defaultNewPlaylistName,
          })
        }
        disabled={saving}
      >
        <Plus className="artist-icon-sm" />
        <span className="artist-track-title">New playlist</span>
      </button>
      {availablePlaylists.length > 0 ? (
        <div className="artist-playlist-menu__scroll">
          {availablePlaylists.map((playlist) => {
            const alreadyAdded = playlistContainsTrack(playlist, track);
            return (
              <button
                key={playlist.id}
                type="button"
                className="artist-menu-item"
                onClick={() =>
                  onSelect?.({
                    mode: "existing",
                    playlistId: playlist.id,
                  })
                }
                disabled={saving || alreadyAdded}
                title={alreadyAdded ? `Already in ${playlist.name}` : undefined}
                aria-label={
                  alreadyAdded ? `${playlist.name}, already added` : `Add to ${playlist.name}`
                }
              >
                <span className="artist-track-title">{playlist.name}</span>
                {alreadyAdded ? (
                  <SearchLibraryCheck size="sm" className="artist-playlist-menu__check" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {error ? <div className="artist-error-text">{error}</div> : null}
    </>
  );
}

export function TrackPlaylistSubmenu({
  label,
  icon: Icon = Plus,
  track = null,
  playlists = [],
  loading = false,
  saving = false,
  error = "",
  defaultNewPlaylistName = "Playlist",
  excludedPlaylistIds = [],
  onSelect,
  onClose,
  toggleOnClick = false,
  isOpen = false,
  onToggle,
}) {
  const handleSelect = async (target) => {
    await onSelect?.(target);
    onClose?.();
  };

  const handleTriggerClick = (event) => {
    event.stopPropagation();
    if (toggleOnClick) {
      onToggle?.();
    }
  };

  return (
    <div className={`artist-menu-submenu${toggleOnClick && isOpen ? " is-open" : ""}`}>
      <button
        type="button"
        className="artist-menu-item artist-menu-submenu__trigger"
        role="menuitem"
        tabIndex={toggleOnClick ? undefined : 0}
        aria-expanded={toggleOnClick ? isOpen : undefined}
        onClick={toggleOnClick ? handleTriggerClick : undefined}
      >
        <span className="artist-menu-item__main">
          <Icon className="artist-icon-sm" />
          {label}
        </span>
        <ChevronRight
          className={`artist-icon-sm${toggleOnClick && isOpen ? " artist-chevron--open" : ""}`}
          aria-hidden="true"
        />
      </button>
      <div className="artist-menu-submenu__panel">
        <TrackPlaylistPickerContent
          track={track}
          playlists={playlists}
          loading={loading}
          saving={saving}
          error={error}
          defaultNewPlaylistName={defaultNewPlaylistName}
          excludedPlaylistIds={excludedPlaylistIds}
          onSelect={handleSelect}
        />
      </div>
    </div>
  );
}

export const TrackPlaylistMenu = forwardRef(function TrackPlaylistMenu(
  {
    track = null,
    playlists = [],
    loading = false,
    saving = false,
    disabled = false,
    error = "",
    defaultNewPlaylistName = "Playlist",
    excludedPlaylistIds = [],
    triggerLabel = "Add to playlist",
    triggerVariant = "expand",
    icon: TriggerIcon = Plus,
    onLoadPlaylists,
    onSelect,
    onOpenChange,
    menuVariant,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const menuRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
      onOpenChange?.(false);
    };
    const handleViewportChange = () => {
      setOpen(false);
      onOpenChange?.(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [onOpenChange, open]);

  const positionMenuFromAnchor = (anchorEl) => {
    const rect = anchorEl?.getBoundingClientRect?.();
    if (!rect) return;
    const menuWidth = 256;
    setMenuPosition({
      top: rect.bottom + 8,
      left: Math.max(12, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12)),
    });
  };

  const openMenu = async (anchorEl) => {
    positionMenuFromAnchor(anchorEl || buttonRef.current);
    setOpen(true);
    onOpenChange?.(true);
    await onLoadPlaylists?.();
  };

  const closeMenu = () => {
    setOpen(false);
    onOpenChange?.(false);
  };

  useImperativeHandle(ref, () => ({
    open: openMenu,
    close: closeMenu,
  }));

  const handleOpen = async (event) => {
    event.stopPropagation();
    if (open) {
      closeMenu();
      return;
    }
    await openMenu(buttonRef.current);
  };

  const handleSelect = async (target) => {
    await onSelect?.(target);
    closeMenu();
  };

  const showTrigger = triggerVariant !== "hidden";
  const triggerClassName = `btn btn-secondary btn-icon btn-xs${open ? " btn-neutral-active" : ""}`;
  const menuClassName = [
    "artist-playlist-menu",
    menuVariant === "preview-tracks" ? "artist-playlist-menu--preview-tracks" : "",
    menuVariant === "search-suggestion" ? "artist-playlist-menu--search-suggestion" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="artist-relative" ref={menuRef}>
      {showTrigger ? (
        triggerVariant === "compact" ? (
          <button
            ref={buttonRef}
            type="button"
            className={triggerClassName}
            onClick={handleOpen}
            title={triggerLabel}
            aria-label={triggerLabel}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={saving || disabled}
          >
            {saving ? (
              <Loader className="artist-icon-xs animate-spin" />
            ) : (
              <TriggerIcon className="artist-icon-xs" />
            )}
          </button>
        ) : (
          <AddActionButton
            ref={buttonRef}
            label={triggerLabel}
            icon={TriggerIcon}
            isLoading={saving}
            disabled={disabled}
            onClick={handleOpen}
            aria-haspopup="menu"
            aria-expanded={open}
          />
        )
      ) : null}

      {open ? (
        <div
          className={menuClassName}
          style={{
            top: menuPosition.top,
            left: menuPosition.left,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <TrackPlaylistPickerContent
            track={track}
            playlists={playlists}
            loading={loading}
            saving={saving}
            error={error}
            defaultNewPlaylistName={defaultNewPlaylistName}
            excludedPlaylistIds={excludedPlaylistIds}
            onSelect={handleSelect}
          />
        </div>
      ) : null}
    </div>
  );
});
