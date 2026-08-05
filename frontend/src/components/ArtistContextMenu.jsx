import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Library, Loader2, MoreVertical, ThumbsDown, ThumbsUp } from "lucide-react";
import { getDiscoveryFeedbackLabel } from "../utils/discoveryFeedback";

const getMenuHorizontalAnchorRect = (button) => {
  const discoverCard = button.closest(".artist-discover-card");
  if (discoverCard) {
    const cover = discoverCard.querySelector(".artist-discover-card__cover");
    if (cover) return cover.getBoundingClientRect();
  }
  const similarCard = button.closest(".artist-similar-card");
  if (similarCard) {
    const avatar = similarCard.querySelector(".artist-similar-avatar");
    if (avatar) return avatar.getBoundingClientRect();
  }
  return button.getBoundingClientRect();
};

let activeMenuCloser = null;

export function ArtistContextMenu({
  artist,
  artistName,
  isInLibrary = false,
  canAddArtist = false,
  onAddToLibrary,
  onFeedback,
  feedbackUsed = {},
  className = "",
  buttonClassName = "btn btn-icon-square artist-context-menu__trigger",
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const menuButtonRef = useRef(null);
  const menuRef = useRef(null);
  const closeMenuRef = useRef(null);
  const labelName = artistName || artist?.name || artist?.artistName || "artist";

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

  const estimateMenuHeight = useCallback(() => {
    let items = 0;
    if (canAddArtist && onAddToLibrary) items += 1;
    if (onFeedback) items += 3;
    return Math.max(items, 1) * 42 + 8;
  }, [canAddArtist, onAddToLibrary, onFeedback]);

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
    const menuHeight = menuRef.current?.offsetHeight || estimateMenuHeight();
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
  }, [estimateMenuHeight]);

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

  const handleAction = async (event, type, fn) => {
    event.stopPropagation();
    if (!fn || pendingAction) return;
    setPendingAction(type);
    const success = await fn(artist);
    if (success) closeMenu();
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

  const showMenuTrigger = (canAddArtist && onAddToLibrary) || onFeedback;

  if (!showMenuTrigger) return null;

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
        className={buttonClassName}
        aria-label={`Artist options for ${labelName}`}
        title={`Artist options for ${labelName}`}
      >
        <MoreVertical className="artist-icon-sm" />
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
              onClick={(event) => event.stopPropagation()}
            >
              {canAddArtist && onAddToLibrary && (
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
              {onFeedback && (
                <>
                  <button
                    type="button"
                    onClick={(event) => handleFeedbackClick(event, "more_like_this")}
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
                    onClick={(event) => handleFeedbackClick(event, "less_like_this")}
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
                    onClick={(event) => handleFeedbackClick(event, "block_artist")}
                    disabled={!!pendingAction}
                    className={`artist-menu-item--discover artist-menu-item--danger${feedbackUsed.block_artist ? " is-selected" : ""}`}
                  >
                    <div className="artist-menu-item__main--discover">
                      {pendingAction === "block_artist" ? (
                        <Loader2 className="artist-icon-sm animate-spin" />
                      ) : (
                        <Ban className="artist-icon-sm" />
                      )}
                      {feedbackUsed.block_artist ? "Unblock artist" : getDiscoveryFeedbackLabel("block_artist")}
                    </div>
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
