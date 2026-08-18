import { createPortal } from "react-dom";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, Loader2, MoreVertical } from "lucide-react";
import TooltipButton from "./TooltipButton";

let activeMenuCloser = null;

export function LibraryItemSubmenu({
  label,
  icon: Icon,
  items = [],
  isOpen = false,
  onToggle,
  onClose,
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const open = typeof onToggle === "function" ? isOpen : internalOpen;

  const handleAction = async (event, item) => {
    event.stopPropagation();
    if (item.disabled || pendingAction) return;
    setPendingAction(item.id);
    try {
      await item.onSelect?.();
      onClose?.();
    } finally {
      setPendingAction("");
    }
  };

  return (
    <div className={`artist-menu-submenu${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="artist-menu-item artist-menu-submenu__trigger"
        role="menuitem"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          if (onToggle) onToggle();
          else setInternalOpen((value) => !value);
        }}
      >
        <span className="artist-menu-item__main">
          {Icon ? <Icon className="artist-icon-sm" /> : null}
          {label}
        </span>
        <ChevronRight
          className={`artist-icon-sm${open ? " artist-chevron--open" : ""}`}
          aria-hidden="true"
        />
      </button>
      <div className="artist-menu-submenu__panel">
        {items.map((item) => {
          const ItemIcon = item.icon;
          const isPending = pendingAction === item.id;
          const isToggle = typeof item.selected === "boolean";
          return (
            <button
              type="button"
              role={isToggle ? "menuitemcheckbox" : "menuitem"}
              className={`artist-menu-item${item.danger ? " artist-menu-item--danger" : ""}${item.selected ? " is-selected" : ""}`}
              key={item.id}
              onClick={(event) => handleAction(event, item)}
              disabled={item.disabled || !!pendingAction}
              aria-checked={isToggle ? item.selected : undefined}
            >
              <span className="artist-menu-item__main">
                {isPending ? (
                  <Loader2 className="artist-icon-sm animate-spin" />
                ) : ItemIcon ? (
                  <ItemIcon className="artist-icon-sm" />
                ) : null}
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const LibraryItemMenu = forwardRef(function LibraryItemMenu(
  {
    label,
    items = [],
    additionalItemsAfter = "",
    renderAdditionalItems,
    onMenuOpen,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [anchor, setAnchor] = useState(null);
  const [position, setPosition] = useState(null);
  const [submenuSide, setSubmenuSide] = useState("right");
  const menuRootRef = useRef(null);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const registeredCloserRef = useRef(null);

  const closeMenu = useCallback((restoreFocus = true) => {
    setOpen(false);
    setAnchor(null);
    setPosition(null);
    setSubmenuSide("right");
    setPendingAction("");
    if (activeMenuCloser === registeredCloserRef.current) {
      activeMenuCloser = null;
      registeredCloserRef.current = null;
    }
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openMenu = useCallback(
    (nextAnchor) => {
      activeMenuCloser?.();
      const closer = () => closeMenu(false);
      registeredCloserRef.current = closer;
      activeMenuCloser = closer;
      setAnchor(nextAnchor);
      setSubmenuSide("right");
      setPosition({
        left: nextAnchor.kind === "context" ? nextAnchor.x : nextAnchor.right,
        top: nextAnchor.kind === "context" ? nextAnchor.y : nextAnchor.bottom,
      });
      setOpen(true);
      onMenuOpen?.();
    },
    [closeMenu, onMenuOpen],
  );

  const openFromTrigger = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ kind: "trigger", top: rect.top, right: rect.right, bottom: rect.bottom });
  }, [openMenu]);

  const openAt = useCallback(
    (x, y) => openMenu({ kind: "context", x, y }),
    [openMenu],
  );

  useImperativeHandle(ref, () => ({ openAt, close: closeMenu }), [closeMenu, openAt]);

  useEffect(() => {
    const target = menuRootRef.current?.closest("[data-library-menu-target]");
    if (!target) return undefined;
    const handleContextMenu = (event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      openAt(event.clientX, event.clientY);
    };
    target.addEventListener("contextmenu", handleContextMenu);
    return () => target.removeEventListener("contextmenu", handleContextMenu);
  }, [openAt]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (
        menuRootRef.current?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      closeMenu(false);
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") closeMenu();
    };
    const closeOnViewportChange = () => closeMenu(false);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [closeMenu, open]);

  useEffect(() => {
    return () => {
      if (activeMenuCloser === registeredCloserRef.current) {
        activeMenuCloser = null;
        registeredCloserRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector("button:not(:disabled)")?.focus();
  }, [open]);

  const updatePosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu || !anchor) return;
    const edge = 8;
    const gap = 8;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = anchor.kind === "context" ? anchor.x : anchor.right - width;
    let top = anchor.kind === "context" ? anchor.y : anchor.bottom + gap;

    if (anchor.kind === "trigger" && top + height > window.innerHeight - edge) {
      top = anchor.top - height - gap;
    }
    left = Math.min(Math.max(edge, left), Math.max(edge, window.innerWidth - width - edge));
    top = Math.min(Math.max(edge, top), Math.max(edge, window.innerHeight - height - edge));
    const submenuWidth = 256;
    const submenuGap = 8;
    const rightSpace = window.innerWidth - left - width - edge;
    const leftSpace = left - edge;
    const nextSubmenuSide =
      rightSpace >= submenuWidth + submenuGap || rightSpace >= leftSpace ? "right" : "left";
    setSubmenuSide(nextSubmenuSide);
    setPosition((current) =>
      current?.left === left && current?.top === top ? current : { left, top },
    );
  }, [anchor]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  const handleAction = async (event, item) => {
    event.stopPropagation();
    if (item.disabled || pendingAction) return;
    setPendingAction(item.id);
    try {
      await item.onSelect?.(event);
    } catch {
    } finally {
      closeMenu();
      setPendingAction("");
    }
  };

  const renderItems = () => (
    <>
      {items.map((item) => {
        const Icon = item.icon;
        const isPending = pendingAction === item.id;
        const isToggle = typeof item.selected === "boolean";
        return (
          <div key={item.id}>
            {item.separatorBefore ? <div className="native-library-item-menu__separator" /> : null}
            <button
              type="button"
              role={isToggle ? "menuitemcheckbox" : "menuitem"}
              className={`artist-menu-item${item.danger ? " artist-menu-item--danger" : ""}${item.selected ? " is-selected" : ""}`}
              onClick={(event) => handleAction(event, item)}
              disabled={item.disabled || !!pendingAction}
              aria-checked={isToggle ? item.selected : undefined}
            >
              <span className="artist-menu-item__main">
                {isPending ? (
                  <Loader2 className="artist-icon-sm animate-spin" />
                ) : Icon ? (
                  <Icon className="artist-icon-sm" />
                ) : null}
                {item.label}
              </span>
            </button>
            {item.id === additionalItemsAfter && renderAdditionalItems?.({ closeMenu })}
          </div>
        );
      })}
      {!items.some((item) => item.id === additionalItemsAfter)
        ? renderAdditionalItems?.({ closeMenu })
        : null}
    </>
  );

  return (
    <div className="native-library-item-menu" ref={menuRootRef}>
      <TooltipButton
        ref={triggerRef}
        className={`native-library-item-menu__trigger${open ? " is-open" : ""}`}
        label={`${label} options`}
        aria-label={`${label} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          if (open) closeMenu();
          else openFromTrigger();
        }}
      >
        <MoreVertical aria-hidden="true" />
      </TooltipButton>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className={`native-library-item-menu__panel${submenuSide === "left" ? " is-submenu-left" : ""}`}
              role="menu"
              aria-label={`${label} actions`}
              style={{ left: position.left, top: position.top }}
              onClick={(event) => event.stopPropagation()}
            >
              {renderItems()}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
