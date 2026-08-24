import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ListMusic, MoreVertical, Plus, RefreshCw } from "lucide-react";
import { DotLoader } from "./DotLoader";

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
  const restoreFocusRef = useRef(false);
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
    if (!button) return;
    const wrapRect = document.querySelector(".app-main-wrap")?.getBoundingClientRect() ?? {
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
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
    const top = placement === "below" ? rect.bottom + gap : rect.top - gap;
    const anchorRect = getMenuHorizontalAnchorRect(button);
    const menuWidth = menuRef.current?.offsetWidth || 200;
    const minLeft = Math.max(8, wrapRect.left + gap);
    const maxLeft = Math.max(
      minLeft,
      Math.min(window.innerWidth - menuWidth - gap, wrapRect.right - menuWidth - gap),
    );
    const left = Math.min(Math.max(anchorRect.right - menuWidth, minLeft), maxLeft);
    setMenuPosition((prev) => {
      if (prev && prev.top === top && prev.left === left && prev.placement === placement) {
        return prev;
      }
      return { top, left, placement };
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
    if (showMenu || isBusy || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    menuButtonRef.current?.focus();
  }, [showMenu, isBusy]);

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
        restoreFocusRef.current = true;
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

  const flowLabel = playlist.adoptedFlowId ? "Open rotating flow" : "Add as rotating flow";
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
        title={`Playlist options for ${playlistName}`}
        aria-haspopup="menu"
        aria-expanded={showMenu}
      >
        {triggerVariant === "add" ? (
          isBusy ? (
            <DotLoader size="md" label={null} />
          ) : (
            <Plus className="artist-icon-md" />
          )
        ) : (
          <MoreVertical className="artist-icon-sm" />
        )}
      </button>
      {showMenu && menuPosition
        ? createPortal(
            <div
              ref={setMenuRef}
              className={`artist-options-menu--discover${menuPosition.placement === "below" ? " is-below" : ""}`}
              style={{
                top: menuPosition.top,
                left: menuPosition.left,
              }}
              role="menu"
              aria-label={`Actions for ${playlistName}`}
              aria-busy={isBusy}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={handleFlowClick}
                disabled={isBusy}
                className={`artist-menu-item--discover${playlist.adoptedFlowId ? " is-selected" : ""}`}
              >
                <div className="artist-menu-item__main--discover">
                  {pendingAction === "flow" || isAdoptingFlow ? (
                    <DotLoader size="sm" label={null} />
                  ) : (
                    <RefreshCw className="artist-icon-sm" />
                  )}
                  {flowLabel}
                </div>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handlePlaylistClick}
                disabled={isBusy}
                className={`artist-menu-item--discover${playlist.adoptedPlaylistId ? " is-selected" : ""}`}
              >
                <div className="artist-menu-item__main--discover">
                  {pendingAction === "playlist" || isAdoptingPlaylist ? (
                    <DotLoader size="sm" label={null} />
                  ) : (
                    <ListMusic className="artist-icon-sm" />
                  )}
                  {playlistLabel}
                </div>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
