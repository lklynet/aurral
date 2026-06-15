import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import PropTypes from "prop-types";
import { ChevronRight, Loader, Plus } from "lucide-react";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import { playlistContainsTrack } from "../../../utils/sharedTrackIdentity";

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
                  alreadyAdded
                    ? `${playlist.name}, already added`
                    : `Add to ${playlist.name}`
                }
              >
                <span className="artist-track-title">{playlist.name}</span>
                {alreadyAdded ? (
                  <SearchLibraryCheck
                    size="sm"
                    className="artist-playlist-menu__check"
                  />
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
    <div
      className={`artist-menu-submenu${toggleOnClick && isOpen ? " is-open" : ""}`}
    >
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
    error = "",
    defaultNewPlaylistName = "Playlist",
    excludedPlaylistIds = [],
    triggerLabel = "Add to playlist",
    triggerVariant = "expand",
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
      left: Math.max(
        12,
        Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12),
      ),
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
  const triggerClassName =
    triggerVariant === "compact"
      ? `btn btn-secondary btn-icon btn-xs${open ? " btn-neutral-active" : ""}`
      : `artist-playlist-trigger${open ? " is-open" : ""}`;
  const menuClassName = [
    "artist-playlist-menu",
    menuVariant === "preview-tracks" ? "artist-playlist-menu--preview-tracks" : "",
    menuVariant === "search-suggestion"
      ? "artist-playlist-menu--search-suggestion"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="artist-relative" ref={menuRef}>
      {showTrigger ? (
        <button
          ref={buttonRef}
          type="button"
          className={triggerClassName}
          onClick={handleOpen}
          title={triggerVariant === "compact" ? triggerLabel : undefined}
          aria-label={triggerLabel}
          aria-expanded={open}
          disabled={saving}
        >
          {triggerVariant === "compact" ? (
            saving ? (
              <Loader className="artist-icon-xs animate-spin" />
            ) : (
              <Plus className="artist-icon-xs" />
            )
          ) : (
            <>
              <span className="artist-playlist-trigger__icon">
                {saving ? (
                  <Loader className="artist-icon-xs animate-spin" />
                ) : (
                  <Plus className="artist-icon-xs" />
                )}
              </span>
              <span className="artist-playlist-trigger__label">
                {triggerLabel}
              </span>
            </>
          )}
        </button>
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

TrackPlaylistPickerContent.propTypes = {
  track: PropTypes.object,
  playlists: PropTypes.array,
  loading: PropTypes.bool,
  saving: PropTypes.bool,
  error: PropTypes.string,
  defaultNewPlaylistName: PropTypes.string,
  excludedPlaylistIds: PropTypes.array,
  onSelect: PropTypes.func,
};

TrackPlaylistSubmenu.propTypes = {
  label: PropTypes.string.isRequired,
  icon: PropTypes.elementType,
  track: PropTypes.object,
  playlists: PropTypes.array,
  loading: PropTypes.bool,
  saving: PropTypes.bool,
  error: PropTypes.string,
  defaultNewPlaylistName: PropTypes.string,
  excludedPlaylistIds: PropTypes.array,
  onSelect: PropTypes.func,
  onClose: PropTypes.func,
  toggleOnClick: PropTypes.bool,
  isOpen: PropTypes.bool,
  onToggle: PropTypes.func,
};

TrackPlaylistMenu.propTypes = {
  track: PropTypes.object,
  playlists: PropTypes.array,
  loading: PropTypes.bool,
  saving: PropTypes.bool,
  error: PropTypes.string,
  defaultNewPlaylistName: PropTypes.string,
  excludedPlaylistIds: PropTypes.array,
  triggerLabel: PropTypes.string,
  triggerVariant: PropTypes.oneOf(["expand", "compact", "hidden"]),
  onLoadPlaylists: PropTypes.func,
  onSelect: PropTypes.func,
  onOpenChange: PropTypes.func,
  menuVariant: PropTypes.oneOf(["preview-tracks", "search-suggestion"]),
};
