import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { ListMusic, Loader2, MoreVertical, Plus, RefreshCw } from "lucide-react";

const MAIN_CONTENT_PORTAL_SELECTOR = ".app-main-wrap";

const getMainContentPortalRoot = () =>
  document.querySelector(MAIN_CONTENT_PORTAL_SELECTOR);

const getMenuHorizontalAnchorRect = (button) => {
  const discoverCard = button.closest(".artist-discover-card");
  if (discoverCard) {
    const cover = discoverCard.querySelector(".artist-discover-card__cover");
    if (cover) return cover.getBoundingClientRect();
  }
  return button.getBoundingClientRect();
};

let activeMenuCloser = null;

export function DiscoverPlaylistContextMenu({
  playlist,
  canAdopt = false,
  adoptingFlowId = null,
  adoptingPlaylistId = null,
  onAdoptFlow,
  onAdoptPlaylist,
  triggerVariant = "icon",
  className = "",
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const menuButtonRef = useRef(null);
  const menuRef = useRef(null);
  const closeMenuRef = useRef(null);
  const playlistName = String(playlist?.name || "playlist").trim() || "playlist";
  const presetId = playlist?.presetId;
  const isAdoptingFlow = adoptingFlowId === presetId;
  const isAdoptingPlaylist = adoptingPlaylistId === presetId;
  const isBusy = isAdoptingFlow || isAdoptingPlaylist || !!pendingAction;

  const closeMenu = useCallback(() => {
    setShowMenu(false);
    if (activeMenuCloser === closeMenuRef.current) {
      activeMenuCloser = null;
    }
  }, []);
  closeMenuRef.current = closeMenu;

  const openMenu = useCallback(() => {
    if (activeMenuCloser && activeMenuCloser !== closeMenuRef.current) {
      activeMenuCloser();
    }
    activeMenuCloser = closeMenuRef.current;
    setShowMenu(true);
  }, []);

  const updateMenuPosition = useCallback(() => {
    const button = menuButtonRef.current;
    const portalRoot = getMainContentPortalRoot();
    if (!button || !portalRoot) return;
    const wrapRect = portalRoot.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const gap = 8;
    const menuHeight = menuRef.current?.offsetHeight || 92;
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
    const anchorRect = getMenuHorizontalAnchorRect(button);
    const right = wrapRect.right - anchorRect.right;
    setMenuPosition((prev) => {
      if (
        prev &&
        prev.top === top &&
        prev.right === right &&
        prev.placement === placement
      ) {
        return prev;
      }
      return { top, right, placement };
    });
  }, []);

  const setMenuRef = useCallback(
    (node) => {
      menuRef.current = node;
      if (node && showMenu) {
        updateMenuPosition();
      }
    },
    [showMenu, updateMenuPosition],
  );

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

  useEffect(() => {
    if (!showMenu) return undefined;
    const handlePointerDown = (event) => {
      if (
        menuButtonRef.current?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      closeMenu();
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showMenu, closeMenu]);

  useEffect(() => {
    return () => {
      if (activeMenuCloser === closeMenuRef.current) {
        activeMenuCloser = null;
      }
    };
  }, []);

  const handleFlowClick = async (event) => {
    event.stopPropagation();
    if (!onAdoptFlow || isBusy) return;
    setPendingAction("flow");
    try {
      await onAdoptFlow(playlist);
      closeMenu();
    } finally {
      setPendingAction(null);
    }
  };

  const handlePlaylistClick = async (event) => {
    event.stopPropagation();
    if (!onAdoptPlaylist || isBusy) return;
    setPendingAction("playlist");
    try {
      await onAdoptPlaylist(playlist);
      closeMenu();
    } finally {
      setPendingAction(null);
    }
  };

  if (!canAdopt || !playlist) return null;

  const flowLabel = playlist.adoptedFlowId
    ? "Open rotating flow"
    : "Add as rotating flow";
  const playlistLabel = playlist.adoptedPlaylistId
    ? "Open static playlist"
    : "Add as static playlist";

  const triggerClassName =
    triggerVariant === "add"
      ? "btn btn-primary discover-playlist-add-button"
      : "btn btn-icon-square artist-context-menu__trigger";

  return (
    <div
      className={className}
      style={{ position: "relative", flexShrink: 0 }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={menuButtonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (showMenu) {
            closeMenu();
          } else {
            openMenu();
          }
        }}
        className={triggerClassName}
        disabled={isBusy}
        aria-label={`Playlist options for ${playlistName}`}
        aria-expanded={showMenu}
      >
        {triggerVariant === "add" ? (
          isBusy ? (
            <Loader2 className="artist-icon-md animate-spin" />
          ) : (
            <Plus className="artist-icon-md" />
          )
        ) : (
          <MoreVertical className="artist-icon-sm" />
        )}
      </button>
      {showMenu && menuPosition && getMainContentPortalRoot()
        ? createPortal(
            <div
              ref={setMenuRef}
              className={`artist-options-menu--discover${menuPosition.placement === "below" ? " is-below" : ""}`}
              style={{
                top: menuPosition.top,
                right: menuPosition.right,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                onClick={handleFlowClick}
                disabled={isBusy}
                className={`artist-menu-item--discover${playlist.adoptedFlowId ? " is-selected" : ""}`}
              >
                <div className="artist-menu-item__main--discover">
                  {pendingAction === "flow" || isAdoptingFlow ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : (
                    <RefreshCw className="artist-icon-sm" />
                  )}
                  {flowLabel}
                </div>
              </button>
              <button
                type="button"
                onClick={handlePlaylistClick}
                disabled={isBusy}
                className={`artist-menu-item--discover${playlist.adoptedPlaylistId ? " is-selected" : ""}`}
              >
                <div className="artist-menu-item__main--discover">
                  {pendingAction === "playlist" || isAdoptingPlaylist ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : (
                    <ListMusic className="artist-icon-sm" />
                  )}
                  {playlistLabel}
                </div>
              </button>
            </div>,
            getMainContentPortalRoot(),
          )
        : null}
    </div>
  );
}

DiscoverPlaylistContextMenu.propTypes = {
  playlist: PropTypes.object.isRequired,
  canAdopt: PropTypes.bool,
  adoptingFlowId: PropTypes.string,
  adoptingPlaylistId: PropTypes.string,
  onAdoptFlow: PropTypes.func,
  onAdoptPlaylist: PropTypes.func,
  triggerVariant: PropTypes.oneOf(["icon", "add"]),
  className: PropTypes.string,
};
