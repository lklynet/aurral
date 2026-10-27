import type { ReactNode } from "react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Plus, Trash2 } from "../../../components/icons";
import type { IconComponent } from "../../../components/icons";
import AddActionButton from "../../../components/AddActionButton";
import { useActiveDownloads } from "../../../hooks/useActiveDownloads";
import { DotLoader } from "../../../components/DotLoader";
import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import TooltipButton from "../../../components/TooltipButton";
import Tooltip from "../../../components/Tooltip";
import type { StaticPlaylist } from "../../playlists/playlistStats.ts";

type PlaylistTrackEntry = { id: string; identity: string };
export type SharedPlaylist = StaticPlaylist;

export type PlaylistTrackIdentity = {
  artistName?: string | null;
  artist?: string | null;
  artist_name?: string | null;
  trackName?: string | null;
  title?: string | null;
  name?: string | null;
  track?: string | null;
  albumName?: string | null;
  album?: string | null;
  artistMbid?: string | null;
  artistId?: string | number | null;
  albumMbid?: string | null;
  releaseGroupMbid?: string | null;
  albumId?: string | number | null;
  trackMbid?: string | null;
  recordingMbid?: string | null;
  recordingId?: string | null;
  mbid?: string | null;
  releaseYear?: string | number | null;
  year?: string | number | null;
};

export type PlaylistSelection =
  | { mode: "new"; name: string }
  | { mode: "existing"; playlistId: string };

export type PlaylistRemoval = { playlistId: string; jobId: PlaylistTrackEntry["id"] };

export type QueueMenuItem = {
  id: string;
  label: string;
  icon: IconComponent;
  disabled: boolean;
  onSelect: () => void;
};

export type TrackPlaylistMenuHandle = {
  open: (anchorEl: HTMLElement | null) => Promise<void>;
  close: () => void;
};

type TrackPlaylistPickerProps = {
  track?: PlaylistTrackIdentity | null;
  playlists?: SharedPlaylist[];
  loading?: boolean;
  saving?: boolean;
  error?: string;
  defaultNewPlaylistName?: string;
  excludedPlaylistIds?: string[];
  onSelect?: (target: PlaylistSelection) => void | Promise<void>;
};

function normalizeTrackForSharedIdentity(track: PlaylistTrackIdentity | null | undefined) {
  if (!track || typeof track !== "object" || Array.isArray(track)) {
    return null;
  }
  const artistName = String(track.artistName ?? track.artist ?? track.artist_name ?? "").trim();
  const trackName = String(
    track.trackName ?? track.title ?? track.name ?? track.track ?? "",
  ).trim();
  if (!artistName || !trackName) return null;
  const albumName = String(track.albumName ?? track.album ?? "").trim();
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

function buildPlaylistTrackIdentity(track: PlaylistTrackIdentity | null | undefined) {
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

function buildCoreTrackIdentity(track: PlaylistTrackIdentity | null | undefined) {
  const normalized = normalizeTrackForSharedIdentity(track);
  if (!normalized) return "";
  return `${normalized.artistName.toLowerCase()}\u0001${normalized.trackName.toLowerCase()}`;
}

function coreIdentityFromStoredIdentity(identity: string) {
  const parts = String(identity || "").split("\u0001");
  if (parts.length < 2) return "";
  return `${parts[0]}\u0001${parts[1]}`;
}

function trackMatchesStoredIdentity(
  storedIdentity: string,
  track: PlaylistTrackIdentity | null | undefined,
) {
  const normalized = normalizeTrackForSharedIdentity(track);
  if (!normalized) return false;
  const targetFull = buildPlaylistTrackIdentity(track);
  if (targetFull && storedIdentity === targetFull) return true;
  const targetCore = buildCoreTrackIdentity(track);
  if (!targetCore) return false;
  return coreIdentityFromStoredIdentity(storedIdentity) === targetCore;
}

function playlistContainsTrack(
  playlist: SharedPlaylist | null | undefined,
  track: PlaylistTrackIdentity | null | undefined,
) {
  if (!track) return false;
  const identities: string[] = Array.isArray(playlist?.trackIdentities)
    ? playlist.trackIdentities
    : [];
  if (identities.length === 0) return false;
  return identities.some((identity) => trackMatchesStoredIdentity(identity, track));
}

function useAvailablePlaylists(playlists: SharedPlaylist[], excludedPlaylistIds: string[]) {
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
}: TrackPlaylistPickerProps) {
  const availablePlaylists = useAvailablePlaylists(playlists, excludedPlaylistIds);

  if (loading) {
    return (
      <div className="artist-menu-item">
        <DotLoader size="sm" label={null} />
        Loading playlists
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="artist-menu-item playlist-menu-new"
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
              <Tooltip
                key={playlist.id}
                content={alreadyAdded ? `Already in ${playlist.name}` : undefined}
              >
                <button
                  type="button"
                  className="artist-menu-item"
                  onClick={() =>
                    onSelect?.({
                      mode: "existing",
                      playlistId: playlist.id,
                    })
                  }
                  disabled={saving || alreadyAdded}
                  aria-label={
                    alreadyAdded ? `${playlist.name}, already added` : `Add to ${playlist.name}`
                  }
                >
                  <span className="artist-track-title">{playlist.name}</span>
                  {alreadyAdded ? (
                    <SearchLibraryCheck size="sm" className="artist-playlist-menu__check" />
                  ) : null}
                </button>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
      {error ? <div className="artist-error-text">{error}</div> : null}
    </>
  );
}

type TrackPlaylistSubmenuProps = TrackPlaylistPickerProps & {
  label: ReactNode;
  icon?: IconComponent;
  onClose?: () => void;
  toggleOnClick?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
};

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
}: TrackPlaylistSubmenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const submenuOpen = typeof onToggle === "function" ? isOpen : internalOpen;

  const handleSelect = async (target: PlaylistSelection) => {
    await onSelect?.(target);
    onClose?.();
  };

  const handleTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (onToggle) onToggle();
    else setInternalOpen((value) => !value);
  };

  return (
    <div className={`artist-menu-submenu${toggleOnClick && submenuOpen ? " is-open" : ""}`}>
      <button
        type="button"
        className="artist-menu-item artist-menu-submenu__trigger"
        role="menuitem"
        tabIndex={toggleOnClick ? undefined : 0}
        aria-expanded={toggleOnClick ? submenuOpen : undefined}
        onClick={toggleOnClick ? handleTriggerClick : undefined}
      >
        <span className="artist-menu-item__main">
          <Icon className="artist-icon-sm" />
          {label}
        </span>
        <ChevronRight
          className={`artist-icon-sm${toggleOnClick && submenuOpen ? " artist-chevron--open" : ""}`}
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

export function TrackPlaylistRemoveSubmenu({
  track = null,
  playlists = [],
  saving = false,
  error = "",
  onSelect,
  onClose,
  toggleOnClick = false,
  isOpen = false,
  onToggle,
}: {
  track?: PlaylistTrackIdentity | null;
  playlists?: SharedPlaylist[];
  saving?: boolean;
  error?: string;
  onSelect?: (removal: PlaylistRemoval) => void | Promise<void>;
  onClose?: () => void;
  toggleOnClick?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const submenuOpen = typeof onToggle === "function" ? isOpen : internalOpen;
  const removablePlaylists = playlists
    .map((playlist) => {
      const entry = (Array.isArray(playlist?.trackEntries) ? playlist.trackEntries : []).find(
        (candidate: PlaylistTrackEntry) => trackMatchesStoredIdentity(candidate?.identity, track),
      );
      return entry ? { playlist, jobId: entry.id } : null;
    })
    .filter((removable) => removable !== null);

  if (!removablePlaylists.length) return null;

  const handleSelect = async (playlistId: string, jobId: PlaylistTrackEntry["id"]) => {
    await onSelect?.({ playlistId, jobId });
    onClose?.();
  };

  return (
    <div className={`artist-menu-submenu${toggleOnClick && submenuOpen ? " is-open" : ""}`}>
      <button
        type="button"
        className="artist-menu-item artist-menu-submenu__trigger"
        role="menuitem"
        aria-expanded={toggleOnClick ? submenuOpen : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (toggleOnClick) {
            if (onToggle) onToggle();
            else setInternalOpen((value) => !value);
          }
        }}
      >
        <span className="artist-menu-item__main">
          <Trash2 className="artist-icon-sm" />
          Remove from playlist
        </span>
        <ChevronRight
          className={`artist-icon-sm${toggleOnClick && submenuOpen ? " artist-chevron--open" : ""}`}
          aria-hidden="true"
        />
      </button>
      <div className="artist-menu-submenu__panel">
        {removablePlaylists.map(({ playlist, jobId }) => (
          <button
            type="button"
            className="artist-menu-item artist-menu-item--danger"
            key={playlist.id}
            onClick={() => handleSelect(playlist.id, jobId)}
            disabled={saving}
          >
            {playlist.name}
          </button>
        ))}
        {error ? <div className="artist-error-text">{error}</div> : null}
      </div>
    </div>
  );
}

type TrackPlaylistMenuProps = TrackPlaylistPickerProps & {
  disabled?: boolean;
  triggerLabel?: string;
  triggerVariant?: "expand" | "kebab" | "compact" | "hidden";
  icon?: IconComponent;
  onAddToLibrary?: ((track: PlaylistTrackIdentity | null) => unknown) | null;
  librarySaving?: boolean;
  queueItems?: QueueMenuItem[];
  onLoadPlaylists?: () => Promise<unknown>;
  onOpenChange?: (open: boolean) => void;
  menuVariant?: "preview-tracks" | "search-suggestion";
};

export const TrackPlaylistMenu = forwardRef<TrackPlaylistMenuHandle, TrackPlaylistMenuProps>(
  function TrackPlaylistMenu(
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
      onAddToLibrary,
      librarySaving = false,
      queueItems = [],
      onLoadPlaylists,
      onSelect,
      onOpenChange,
      menuVariant,
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [openSubmenu, setOpenSubmenu] = useState(false);
    const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
    const menuRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const { isAlbumDownloading, isTrackDownloading } = useActiveDownloads();
    const downloading =
      Boolean(onAddToLibrary) &&
      (isTrackDownloading(track) || isAlbumDownloading(track?.albumMbid));

    useEffect(() => {
      if (!open) return undefined;
      const handlePointerDown = (event: PointerEvent) => {
        const target = event.target instanceof Node ? event.target : null;
        if (menuRef.current?.contains(target) || panelRef.current?.contains(target)) {
          return;
        }
        setOpen(false);
        setOpenSubmenu(false);
        onOpenChange?.(false);
      };
      const handleViewportChange = (event: Event) => {
        if (
          event?.type === "scroll" &&
          event.target instanceof Node &&
          panelRef.current?.contains(event.target)
        )
          return;
        setOpen(false);
        setOpenSubmenu(false);
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

    const positionMenuFromAnchor = (anchorEl: HTMLElement | null) => {
      const rect = anchorEl?.getBoundingClientRect?.();
      if (!rect) return;
      const menuWidth = 256;
      setMenuPosition({
        top: rect.bottom + 8,
        left: Math.max(12, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12)),
      });
    };

    const openMenu = async (anchorEl: HTMLElement | null) => {
      positionMenuFromAnchor(anchorEl || buttonRef.current);
      setOpen(true);
      onOpenChange?.(true);
      await onLoadPlaylists?.();
    };

    const closeMenu = () => {
      setOpen(false);
      setOpenSubmenu(false);
      onOpenChange?.(false);
    };

    useImperativeHandle(ref, () => ({
      open: openMenu,
      close: closeMenu,
    }));

    const handleOpen = async (event: React.MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      if (open) {
        closeMenu();
        return;
      }
      await openMenu(buttonRef.current);
    };

    const handleSelect = async (target: PlaylistSelection) => {
      await onSelect?.(target);
      closeMenu();
    };

    const showTrigger = triggerVariant !== "hidden";
    const isKebab = triggerVariant === "kebab";
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
          isKebab ? (
            <AddActionButton
              ref={buttonRef}
              label={
                queueItems.length
                  ? onAddToLibrary
                    ? "Add to queue, library, or playlist"
                    : "Add to queue or playlist"
                  : onAddToLibrary
                    ? "Add to library or playlist"
                    : triggerLabel
              }
              icon={Plus}
              isLoading={saving || librarySaving}
              busy={downloading}
              loadingLabel={downloading ? "Downloading" : null}
              disabled={disabled}
              onClick={handleOpen}
              aria-haspopup="menu"
              aria-expanded={open}
            />
          ) : triggerVariant === "compact" ? (
            <TooltipButton
              ref={buttonRef}
              type="button"
              className={triggerClassName}
              onClick={handleOpen}
              label={triggerLabel}
              aria-label={triggerLabel}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={saving || disabled}
            >
              {saving ? (
                <DotLoader size="xs" label={null} />
              ) : (
                <TriggerIcon className="artist-icon-xs" />
              )}
            </TooltipButton>
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

        {open
          ? createPortal(
              <div
                ref={panelRef}
                className={menuClassName}
                style={{
                  top: menuPosition.top,
                  left: menuPosition.left,
                }}
                onClick={(event) => event.stopPropagation()}
              >
                {isKebab ? (
                  <>
                    {queueItems.map((item) => {
                      const ItemIcon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="artist-menu-item"
                          disabled={item.disabled}
                          onClick={() => {
                            item.onSelect();
                            closeMenu();
                          }}
                        >
                          <span className="artist-menu-item__main">
                            <ItemIcon className="artist-icon-sm" />
                            {item.label}
                          </span>
                        </button>
                      );
                    })}
                    {queueItems.length && (onAddToLibrary || onSelect) ? (
                      <div className="native-library-item-menu__separator" />
                    ) : null}
                    {onAddToLibrary ? (
                      <button
                        type="button"
                        className="artist-menu-item"
                        onClick={async () => {
                          await onAddToLibrary?.(track);
                          closeMenu();
                        }}
                        disabled={saving || librarySaving || downloading || disabled}
                      >
                        <span className="artist-menu-item__main">
                          {downloading ? (
                            <DotLoader size="xs" label={null} />
                          ) : (
                            <Plus className="artist-icon-sm" />
                          )}
                          {downloading ? "Downloading…" : "Add to library"}
                        </span>
                      </button>
                    ) : null}
                    {onSelect ? (
                      <TrackPlaylistSubmenu
                        label="Add to playlist"
                        icon={Plus}
                        track={track}
                        playlists={playlists}
                        loading={loading}
                        saving={saving}
                        error={error}
                        defaultNewPlaylistName={defaultNewPlaylistName}
                        excludedPlaylistIds={excludedPlaylistIds}
                        onSelect={onSelect}
                        onClose={closeMenu}
                        toggleOnClick
                        isOpen={openSubmenu}
                        onToggle={() => setOpenSubmenu((current) => !current)}
                      />
                    ) : null}
                  </>
                ) : (
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
                )}
              </div>,
              document.body,
            )
          : null}
      </div>
    );
  },
);
