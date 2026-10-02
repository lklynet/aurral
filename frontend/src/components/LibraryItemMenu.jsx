import { createPortal } from "react-dom";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight, MoreVertical } from "lucide-react";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";

let activeMenuCloser = null;

const menuItemRole = (item) => {
  if (item.radio) return "menuitemradio";
  return typeof item.selected === "boolean" || typeof item.checked === "boolean"
    ? "menuitemcheckbox"
    : "menuitem";
};

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
  const [panelTop, setPanelTop] = useState(0);
  const panelRef = useRef(null);
  const correctionFrameRef = useRef(null);
  const open = typeof onToggle === "function" ? isOpen : internalOpen;

  const keepPanelInViewport = useCallback(() => {
    if (correctionFrameRef.current != null) {
      window.cancelAnimationFrame(correctionFrameRef.current);
    }
    correctionFrameRef.current = window.requestAnimationFrame(() => {
      correctionFrameRef.current = null;
      const panel = panelRef.current;
      if (!panel || window.matchMedia("(max-width: 767px)").matches) return;
      const edge = 8;
      const rect = panel.getBoundingClientRect();
      let adjustment = 0;
      if (rect.top < edge) adjustment = edge - rect.top;
      if (rect.bottom + adjustment > window.innerHeight - edge) {
        adjustment -= rect.bottom + adjustment - (window.innerHeight - edge);
      }
      if (adjustment) setPanelTop((current) => current + adjustment);
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    setPanelTop(0);
    keepPanelInViewport();
  }, [keepPanelInViewport, open]);

  useEffect(() => () => {
    if (correctionFrameRef.current != null) {
      window.cancelAnimationFrame(correctionFrameRef.current);
    }
  }, []);

  const handleAction = async (event, item) => {
    event.stopPropagation();
    if (item.disabled || pendingAction) return;
    setPendingAction(item.id);
    try {
      await item.onSelect?.();
      onClose?.();
    } catch {
    } finally {
      setPendingAction("");
    }
  };

  return (
    <div
      className={`artist-menu-submenu${open ? " is-open" : ""}`}
      onPointerEnter={keepPanelInViewport}
      onFocusCapture={keepPanelInViewport}
    >
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
      <div className="artist-menu-submenu__panel" ref={panelRef} style={{ top: panelTop }}>
        {items.map((item) => {
          const ItemIcon = item.icon;
          const isPending = pendingAction === item.id;
          const role = menuItemRole(item);
          return (
            <button
              type="button"
              role={role}
              className={`artist-menu-item${item.danger ? " artist-menu-item--danger" : ""}${item.selected ? " is-selected" : ""}`}
              key={item.id}
              onClick={(event) => handleAction(event, item)}
              disabled={item.disabled || !!pendingAction}
              aria-checked={role === "menuitem" ? undefined : Boolean(item.checked ?? item.selected)}
            >
              <span className="artist-menu-item__main">
                {isPending ? (
                  <DotLoader size="sm" label={null} />
                ) : ItemIcon ? (
                  <ItemIcon className="artist-icon-sm" />
                ) : null}
                {item.label}
              </span>
              {item.radio && item.selected ? <Check className="artist-icon-sm" aria-hidden="true" /> : null}
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
    triggerIcon = <MoreVertical aria-hidden="true" />,
    triggerLabel = `${label} options`,
    triggerClassName = "native-library-item-menu__trigger",
    menuLabel = `${label} actions`,
    disabled = false,
    contextMenu = true,
    align = "end",
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
    const registeredCloser = registeredCloserRef.current;
    const ownsActiveMenu =
      registeredCloser !== null && activeMenuCloser === registeredCloser;
    setOpen(false);
    setAnchor(null);
    setPosition(null);
    setSubmenuSide("right");
    setPendingAction("");
    if (ownsActiveMenu) {
      activeMenuCloser = null;
      registeredCloserRef.current = null;
    }
    if (restoreFocus && ownsActiveMenu) {
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
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
    openMenu({ kind: "trigger", top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom });
  }, [openMenu]);

  const openAt = useCallback(
    (x, y) => openMenu({ kind: "context", x, y }),
    [openMenu],
  );

  useImperativeHandle(ref, () => ({ openAt, close: closeMenu }), [closeMenu, openAt]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const target = menuRootRef.current?.closest("[data-library-menu-target]");
    if (!target) return undefined;
    const handleContextMenu = (event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      openAt(event.clientX, event.clientY);
    };
    target.addEventListener("contextmenu", handleContextMenu);
    return () => target.removeEventListener("contextmenu", handleContextMenu);
  }, [contextMenu, openAt]);

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
    const handleScroll = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      if (anchor?.kind !== "trigger") {
        closeMenu(false);
        return;
      }
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ kind: "trigger", top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom });
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [anchor, closeMenu, open]);

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
    menuRef.current?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [open]);

  const updatePosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu || !anchor) return;
    const edge = 8;
    const gap = 8;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = anchor.kind === "context" ? anchor.x : align === "start" ? anchor.left : anchor.right - width;
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
  }, [align, anchor]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  const handleAction = async (event, item) => {
    event.stopPropagation();
    if (item.disabled || pendingAction) return;
    setPendingAction(item.id);
    try {
      if (item.closeBeforeSelect) {
        closeMenu(false);
        triggerRef.current?.focus({ preventScroll: true });
        await item.onSelect?.(event);
        return;
      }
      await item.onSelect?.(event);
    } catch {
    } finally {
      if (!item.closeBeforeSelect) closeMenu();
      setPendingAction("");
    }
  };

  const handleMenuKeyDown = (event) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const buttons = [...(menuRef.current?.querySelectorAll("button:not(:disabled)") || [])]
      .filter((button) => button.checkVisibility());
    if (!buttons.length) return;
    event.preventDefault();
    event.stopPropagation();
    const current = buttons.indexOf(document.activeElement);
    const next = {
      ArrowDown: (current + 1) % buttons.length,
      ArrowUp: (current - 1 + buttons.length) % buttons.length,
      Home: 0,
      End: buttons.length - 1,
    }[event.key];
    buttons[next].focus({ preventScroll: true });
  };

  const renderItems = () => (
    <>
      {items.map((item) => {
        const Icon = item.icon;
        const isPending = pendingAction === item.id;
        const role = menuItemRole(item);
        if (Array.isArray(item.submenuItems)) {
          return (
            <div key={item.id}>
              {item.separatorBefore ? <div className="native-library-item-menu__separator" /> : null}
              <LibraryItemSubmenu
                label={item.label}
                icon={Icon}
                items={item.submenuItems}
                onClose={closeMenu}
              />
              {item.id === additionalItemsAfter && renderAdditionalItems?.({ closeMenu })}
            </div>
          );
        }
        return (
          <div key={item.id}>
            {item.separatorBefore ? <div className="native-library-item-menu__separator" /> : null}
            <button
              type="button"
              role={role}
              className={`artist-menu-item${item.danger ? " artist-menu-item--danger" : ""}${item.selected ? " is-selected" : ""}`}
              onClick={(event) => handleAction(event, item)}
              disabled={item.disabled || !!pendingAction}
              aria-checked={role === "menuitem" ? undefined : Boolean(item.checked ?? item.selected)}
            >
              <span className="artist-menu-item__main">
                {isPending ? (
                  <DotLoader size="sm" label={null} />
                ) : Icon ? (
                  <Icon className="artist-icon-sm" />
                ) : null}
                {item.label}
              </span>
              {item.radio && item.selected ? <Check className="artist-icon-sm" aria-hidden="true" /> : null}
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
        className={`${triggerClassName}${open ? " is-open" : ""}`}
        label={triggerLabel}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (open) closeMenu();
          else openFromTrigger();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || open) return;
          event.preventDefault();
          event.stopPropagation();
          openFromTrigger();
        }}
      >
        {triggerIcon}
      </TooltipButton>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              className={`native-library-item-menu__panel${submenuSide === "left" ? " is-submenu-left" : ""}`}
              role="menu"
              aria-label={menuLabel}
              style={{ left: position.left, top: position.top }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={handleMenuKeyDown}
            >
              {renderItems()}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
