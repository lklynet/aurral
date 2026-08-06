import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Menu,
  Sparkles,
  Library,
  Activity,
  Ellipsis,
  Ticket,
  AudioWaveform,
  Settings,
  LogOut,
  User,
} from "lucide-react";
import Sidebar from "./Sidebar";
import GlobalSearch from "./GlobalSearch";
import GlobalPlayerBar from "./GlobalPlayerBar";
import UserProfileMenu from "./UserProfileMenu";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { DEFAULT_SETTINGS_TAB } from "../pages/Settings/settingsTabsConfig";
import { useModalDialog } from "../hooks/useModalDialog.js";

const SIDEBAR_THRESHOLD = 100;
const SIDEBAR_MIN = 56;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 208;
const MOBILE_SHEET_EXIT_MS = 180;

function Layout({ children }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [scrollbar, setScrollbar] = useState({
    visible: false,
    active: false,
    top: 0,
    height: 0,
  });
  const mainScrollRef = useRef(null);
  const scrollbarTrackRef = useRef(null);
  const scrollbarDragRef = useRef(null);
  const scrollbarFadeTimeoutRef = useRef(null);
  const sidebarResizeSessionRef = useRef(null);
  const mobileMenuInitialFocusRef = useRef(null);
  const [mobileMenuPresence, setMobileMenuPresence] = useState("closed");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const w = parseInt(localStorage.getItem("sidebarWidth"), 10);
      return w >= SIDEBAR_MIN && w <= SIDEBAR_MAX ? w : SIDEBAR_DEFAULT;
    } catch {
      return SIDEBAR_DEFAULT;
    }
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const [lastFullWidth, setLastFullWidth] = useState(() => {
    try {
      const w = parseInt(localStorage.getItem("sidebarFullWidth"), 10);
      return w >= SIDEBAR_THRESHOLD && w <= SIDEBAR_MAX ? w : SIDEBAR_DEFAULT;
    } catch {
      return SIDEBAR_DEFAULT;
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const location = useLocation();
  const { authRequired, canLogOut, logout, user } = useAuth();
  const { isActive: isPlayerActive } = useAudioQueue();
  const isArtistDetailsRoute = /^\/artist\/[^/]+(\/(albums|appears-on|release\/[^/]+))?$/.test(
    location.pathname,
  );
  const isSettingsRoute = location.pathname.startsWith("/settings");
  const closeMobileMenu = useCallback(() => setIsMobileMenuOpen(false), []);
  const mobileMenuDialog = useModalDialog({
    open: mobileMenuPresence !== "closed",
    onClose: closeMobileMenu,
    initialFocusRef: mobileMenuInitialFocusRef,
  });

  const sidebarMode = sidebarWidth < SIDEBAR_THRESHOLD ? "icons" : "full";

  const updateMainScrollbar = useCallback(() => {
    const node = mainScrollRef.current;
    if (!node) return;
    const { scrollTop, scrollHeight, clientHeight } = node;
    const scrollable = scrollHeight > clientHeight + 1;
    if (!scrollable) {
      setScrollbar((current) =>
        current.visible ? { visible: false, active: false, top: 0, height: 0 } : current,
      );
      return;
    }
    const minThumbHeight = 48;
    const thumbHeight = Math.max(minThumbHeight, (clientHeight / scrollHeight) * clientHeight);
    const maxTop = Math.max(clientHeight - thumbHeight, 0);
    const top =
      scrollHeight === clientHeight ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    setScrollbar((current) => ({
      visible: true,
      active: current.active,
      top,
      height: thumbHeight,
    }));
  }, []);

  const showScrollbarTemporarily = useCallback(() => {
    setScrollbar((current) => (current.visible ? { ...current, active: true } : current));
    if (scrollbarFadeTimeoutRef.current) {
      clearTimeout(scrollbarFadeTimeoutRef.current);
    }
    scrollbarFadeTimeoutRef.current = window.setTimeout(() => {
      setScrollbar((current) => ({ ...current, active: false }));
    }, 900);
  }, []);

  const isActive = useCallback(
    (path) => {
      if (path === "/discover" && location.pathname === "/") return true;
      if (path.startsWith("/settings")) {
        return location.pathname.startsWith("/settings");
      }
      if (path.startsWith("/shows")) {
        return location.pathname.startsWith("/shows");
      }
      if (path.startsWith("/activity")) {
        return location.pathname.startsWith("/activity");
      }
      if (path.startsWith("/history")) {
        return location.pathname.startsWith("/activity");
      }
      return location.pathname === path;
    },
    [location.pathname],
  );

  const mobilePrimaryItems = useMemo(() => {
    const items = [
      { path: "/discover", label: "Discover", icon: Sparkles },
      { path: "/library", label: "Library", icon: Library },
      {
        path: "/playlists",
        label: "Playlists",
        icon: AudioWaveform,
        permission: "accessFlow",
      },
    ];
    return items.filter(
      (item) =>
        !item.permission || user?.role === "admin" || !!user?.permissions?.[item.permission],
    );
  }, [user]);

  const mobileOverflowItems = useMemo(() => {
    const items = [
      { path: "/shows/all", label: "Shows", icon: Ticket },
      { path: "/activity/queue", label: "Activity", icon: Activity },
      { path: "/profile", label: "Profile", icon: User },
      {
        path: `/settings/${DEFAULT_SETTINGS_TAB}`,
        label: "Settings",
        icon: Settings,
        permission: "accessSettings",
      },
    ];
    return items.filter(
      (item) =>
        !item.permission || user?.role === "admin" || !!user?.permissions?.[item.permission],
    );
  }, [user]);

  const persistSidebarWidth = useCallback((width) => {
    const nextWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(width)));
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    if (nextWidth >= SIDEBAR_THRESHOLD) {
      setLastFullWidth(nextWidth);
      try {
        localStorage.setItem("sidebarFullWidth", String(nextWidth));
      } catch {}
    }
    try {
      localStorage.setItem("sidebarWidth", String(nextWidth));
    } catch {}
    return nextWidth;
  }, []);

  const handleResizeStart = useCallback((event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const sidebar = document.querySelector(".sidebar-shell");
    const rect = sidebar?.getBoundingClientRect();
    sidebarResizeSessionRef.current = {
      pointerId: event.pointerId,
      left: rect?.left ?? 4,
      grabOffset: event.clientX - (rect?.right ?? event.clientX),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  }, []);

  const handleResizeMove = useCallback((event) => {
    const session = sidebarResizeSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const nextWidth = Math.max(
      SIDEBAR_MIN,
      Math.min(SIDEBAR_MAX, event.clientX - session.left - session.grabOffset),
    );
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
  }, []);

  const handleResizeEnd = useCallback(
    (event) => {
      const session = sidebarResizeSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      sidebarResizeSessionRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setIsResizing(false);
      persistSidebarWidth(sidebarWidthRef.current);
    },
    [persistSidebarWidth],
  );

  const handleResizeKeyDown = useCallback(
    (event) => {
      const step = event.shiftKey ? 24 : 8;
      let nextWidth = sidebarWidth;
      if (event.key === "ArrowLeft") nextWidth -= step;
      else if (event.key === "ArrowRight") nextWidth += step;
      else if (event.key === "Home") nextWidth = SIDEBAR_MIN;
      else if (event.key === "End") nextWidth = SIDEBAR_MAX;
      else return;
      event.preventDefault();
      persistSidebarWidth(nextWidth);
    },
    [persistSidebarWidth, sidebarWidth],
  );

  const handleResizeReset = useCallback(
    (event) => {
      event.preventDefault();
      persistSidebarWidth(SIDEBAR_DEFAULT);
    },
    [persistSidebarWidth],
  );

  const updateScrollFromPointer = useCallback((clientY) => {
    const node = mainScrollRef.current;
    const track = scrollbarTrackRef.current;
    const session = scrollbarDragRef.current;
    if (!node || !track || !session) return;
    const rect = track.getBoundingClientRect();
    const maxThumbTop = Math.max(rect.height - scrollbar.height, 0);
    const thumbTop = Math.min(
      Math.max(clientY - rect.top - session.grabOffset, 0),
      maxThumbTop,
    );
    const scrollRange = Math.max(node.scrollHeight - node.clientHeight, 0);
    node.scrollTop = maxThumbTop > 0 ? (thumbTop / maxThumbTop) * scrollRange : 0;
  }, [scrollbar.height]);

  const handleScrollbarPointerDown = useCallback(
    (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      if (scrollbarFadeTimeoutRef.current) clearTimeout(scrollbarFadeTimeoutRef.current);
      const thumbRect = event.currentTarget.getBoundingClientRect();
      scrollbarDragRef.current = {
        pointerId: event.pointerId,
        grabOffset: event.clientY - thumbRect.top,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setScrollbar((current) => ({ ...current, active: true }));
    },
    [],
  );

  const handleScrollbarPointerMove = useCallback(
    (event) => {
      if (scrollbarDragRef.current?.pointerId !== event.pointerId) return;
      updateScrollFromPointer(event.clientY);
    },
    [updateScrollFromPointer],
  );

  const handleScrollbarPointerEnd = useCallback(
    (event) => {
      if (scrollbarDragRef.current?.pointerId !== event.pointerId) return;
      scrollbarDragRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      showScrollbarTemporarily();
    },
    [showScrollbarTemporarily],
  );

  const toggleSidebarPin = useCallback(() => {
    if (sidebarWidth < SIDEBAR_THRESHOLD) {
      const restoreTo = lastFullWidth;
      setSidebarWidth(restoreTo);
      try {
        localStorage.setItem("sidebarWidth", String(restoreTo));
      } catch {}
    } else {
      setLastFullWidth(sidebarWidth);
      try {
        localStorage.setItem("sidebarFullWidth", String(sidebarWidth));
      } catch {}
      setSidebarWidth(SIDEBAR_MIN);
      try {
        localStorage.setItem("sidebarWidth", String(SIDEBAR_MIN));
      } catch {}
    }
  }, [sidebarWidth, lastFullWidth]);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    let frameId;
    let timeoutId;
    if (isMobileMenuOpen) {
      setMobileMenuPresence("opening");
      frameId = window.requestAnimationFrame(() => setMobileMenuPresence("open"));
    } else {
      setMobileMenuPresence((current) => (current === "closed" ? current : "closing"));
      timeoutId = window.setTimeout(
        () => setMobileMenuPresence("closed"),
        MOBILE_SHEET_EXIT_MS,
      );
    }
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isMobileMenuOpen]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    mainScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    window.requestAnimationFrame(updateMainScrollbar);
  }, [location.pathname, location.search, updateMainScrollbar]);

  useEffect(() => {
    const update = () => updateMainScrollbar();
    update();
    window.addEventListener("resize", update);
    const node = mainScrollRef.current;
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (node && observer) {
      observer.observe(node);
      if (node.firstElementChild) {
        observer.observe(node.firstElementChild);
      }
    }
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [children, updateMainScrollbar]);

  useEffect(
    () => () => {
      if (scrollbarFadeTimeoutRef.current) {
        clearTimeout(scrollbarFadeTimeoutRef.current);
      }
    },
    [],
  );

  return (
    <div
      className="app-shell"
      data-sidebar-mode={sidebarMode}
      data-resizing={isResizing || undefined}
      style={{ "--sidebar-width": `${sidebarWidth}px` }}
    >
      <Sidebar mode={sidebarMode} width={sidebarWidth} settingsMode={isSettingsRoute} />

      <div
        className={`sidebar-resize-handle${isResizing ? " is-active" : ""}`}
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        onLostPointerCapture={handleResizeEnd}
        onDoubleClick={handleResizeReset}
        onKeyDown={handleResizeKeyDown}
      />

      <div
        className={`app-content${
          sidebarMode === "full"
            ? " app-content--sidebar-full"
            : sidebarMode === "icons"
              ? " app-content--sidebar-icons"
              : ""
        }${isPlayerActive ? " app-content--player-active" : ""}`}
      >
        <header className="app-topbar">
          <button
            type="button"
            onClick={toggleSidebarPin}
            className="app-nav-toggle"
            aria-label={sidebarMode === "icons" ? "Expand sidebar" : "Collapse to icons"}
            title={sidebarMode === "icons" ? "Expand sidebar" : "Collapse to icons"}
          >
            <Menu aria-hidden="true" />
          </button>

          <GlobalSearch settingsMode={isSettingsRoute} />

          <div className="app-header-actions">
            <UserProfileMenu />
          </div>
        </header>

        <div className="app-main-wrap">
          <main
            className={`app-main${
              isArtistDetailsRoute ? " app-main--artist-details" : ""
            }${isSettingsRoute ? " app-main--settings" : ""}${
              isPlayerActive ? " app-main--player-active" : ""
            }`}
            ref={mainScrollRef}
            onScroll={() => {
              updateMainScrollbar();
              showScrollbarTemporarily();
            }}
          >
            <div className="app-main__content">{children}</div>
          </main>
          <div
            ref={scrollbarTrackRef}
            className={`app-main-scrollbar${scrollbar.visible ? " is-visible" : ""}${
              scrollbar.active ? " is-active" : ""
            }`}
            aria-hidden="true"
          >
            <div
              className="app-main-scrollbar__thumb"
              onPointerDown={handleScrollbarPointerDown}
              onPointerMove={handleScrollbarPointerMove}
              onPointerUp={handleScrollbarPointerEnd}
              onPointerCancel={handleScrollbarPointerEnd}
              onLostPointerCapture={handleScrollbarPointerEnd}
              style={{
                height: `${scrollbar.height}px`,
                transform: `translateY(${scrollbar.top}px)`,
              }}
            />
          </div>
        </div>

        <GlobalPlayerBar />

        {mobileMenuPresence !== "closed" && (
          <div
            className={`app-mobile-backdrop app-mobile-only is-${mobileMenuPresence}`}
            onClick={mobileMenuDialog.handleBackdropClick}
          >
            <div
              id="mobile-navigation-menu"
              ref={mobileMenuDialog.dialogRef}
              className="app-mobile-menu"
              role="dialog"
              aria-modal="true"
              aria-label="More navigation options"
              tabIndex={-1}
            >
              <nav className="app-mobile-menu__nav">
                {mobileOverflowItems.map((item, index) => {
                  const Icon = item.icon;
                  const active = isActive(item.path);
                  return (
                    <Link
                      key={item.path}
                      ref={index === 0 ? mobileMenuInitialFocusRef : undefined}
                      to={item.path}
                      className={`app-mobile-menu__item${active ? " is-active" : ""}`}
                    >
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
                {authRequired && canLogOut && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileMenuOpen(false);
                      logout();
                    }}
                    className="app-mobile-menu__item"
                  >
                    <LogOut aria-hidden="true" />
                    <span>Log out</span>
                  </button>
                )}
              </nav>
            </div>
          </div>
        )}

        <nav className="app-mobile-nav app-mobile-only" aria-label="Mobile navigation">
          <div className="app-mobile-nav__grid">
            {mobilePrimaryItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`app-mobile-nav__item${active ? " is-active" : ""}`}
                >
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen((open) => !open)}
              className={`app-mobile-nav__item${
                isMobileMenuOpen || mobileOverflowItems.some((item) => isActive(item.path))
                  ? " is-active"
                  : ""
              }`}
              aria-label="More navigation options"
              aria-expanded={isMobileMenuOpen}
              aria-controls="mobile-navigation-menu"
            >
              <Ellipsis aria-hidden="true" />
              <span>More</span>
            </button>
          </div>
        </nav>
      </div>
    </div>
  );
}

export default Layout;
