import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import RouteLink from "./RouteLink";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import { useEdgeSwipeBack } from "../hooks/useEdgeSwipeBack.ts";
import {
  Sparkles,
  Library,
  Activity,
  Ellipsis,
  Ticket,
  Workflow,
  Settings,
  LogOut,
  ChevronLeft,
} from "./icons";
import Sidebar from "./Sidebar";
import GlobalSearch from "./GlobalSearch";
import GlobalPlayerBar from "./GlobalPlayerBar";
import UserProfileMenu from "./UserProfileMenu";
import InboxMenu from "./InboxMenu";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext";
import {
  SettingsLink,
  readSettingsPath,
  withoutSettingsParam,
} from "../pages/Settings/settingsRoute";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { useSectionNav } from "../navigation/useSectionNav.ts";
import { useNavBeta } from "../navigation/navBeta.ts";
import { isLibrarySectionPath, useDiscoverRecent } from "../contexts/DiscoverRecentProvider";

const SIDEBAR_THRESHOLD = 100;
const SIDEBAR_MIN = 56;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 208;
const MOBILE_SHEET_EXIT_MS = 180;
const PLAYER_MINIMIZED_KEY = "playerMinimized";

const SettingsModal = lazy(() => import("../pages/Settings/SettingsModal"));

type ScrollbarDrag = { pointerId: number; grabOffset: number };
type SidebarResizeSession = { pointerId: number; left: number; grabOffset: number };

type LayoutProps = {
  children: ReactNode;
  headerActions: ReactNode;
};

function Layout({ children, headerActions }: LayoutProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [scrollbar, setScrollbar] = useState({
    visible: false,
    active: false,
    top: 0,
    height: 0,
  });
  const mainScrollRef = useRef<HTMLElement>(null);
  const mainWrapRef = useRef<HTMLDivElement>(null);
  const [isMainScrolled, setIsMainScrolled] = useState(false);
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarDragRef = useRef<ScrollbarDrag | null>(null);
  const scrollbarFadeTimeoutRef = useRef<number | null>(null);
  const sidebarResizeSessionRef = useRef<SidebarResizeSession | null>(null);
  const mobileMenuInitialFocusRef = useRef<HTMLAnchorElement>(null);
  const [mobileMenuPresence, setMobileMenuPresence] = useState("closed");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const w = parseInt(String(localStorage.getItem("sidebarWidth")), 10);
      return w >= SIDEBAR_MIN && w <= SIDEBAR_MAX ? w : SIDEBAR_DEFAULT;
    } catch {
      return SIDEBAR_DEFAULT;
    }
  });
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const [lastFullWidth, setLastFullWidth] = useState(() => {
    try {
      const w = parseInt(String(localStorage.getItem("sidebarFullWidth")), 10);
      return w >= SIDEBAR_THRESHOLD && w <= SIDEBAR_MAX ? w : SIDEBAR_DEFAULT;
    } catch {
      return SIDEBAR_DEFAULT;
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const [playerMinimized, setPlayerMinimized] = useState(() => {
    try {
      return localStorage.getItem(PLAYER_MINIMIZED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const changePlayerMinimized = useCallback((minimized: boolean) => {
    setPlayerMinimized(minimized);
    try {
      localStorage.setItem(PLAYER_MINIMIZED_KEY, String(minimized));
    } catch {}
  }, []);
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const scrollPositionsRef = useRef(new Map<string, number>());
  const scrolledPageRef = useRef<{ pathname: string; search: string } | null>(null);
  const sectionNav = useSectionNav();
  const sectionRoot = sectionNav?.root ? sectionNav : null;
  const navBeta = useNavBeta();
  const { isDiscoverSectionActive } = useDiscoverRecent();
  const sectionBarRef = useRef<HTMLElement>(null);
  const { authRequired, canLogOut, logout, user, bootstrap } = useAuth();
  const { isActive: isPlayerActive } = useAudioQueue();
  const isArtistDetailsRoute = /^\/artist\/[^/]+(\/(albums|appears-on))?$/.test(location.pathname);
  const settingsOpen = readSettingsPath(location.search) !== null;
  const pageSearch = withoutSettingsParam(location.search);
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
    (path: string) => {
      if (path === "/") {
        return isDiscoverSectionActive || (navBeta && location.pathname === "/discover/news");
      }
      if (path.startsWith("/shows")) {
        return location.pathname.startsWith("/shows");
      }
      if (path.startsWith("/flows")) {
        return location.pathname.startsWith("/flows");
      }
      if (path.startsWith("/activity")) {
        return location.pathname.startsWith("/activity");
      }
      if (path === "/library") {
        return isLibrarySectionPath(location.pathname, isDiscoverSectionActive);
      }
      return location.pathname === path;
    },
    [isDiscoverSectionActive, location.pathname, navBeta],
  );

  const mobilePrimaryItems = [
    { path: "/", label: "Discover", icon: Sparkles },
    { path: "/library", label: "Library", icon: Library },
    { path: "/activity/queue", label: "Activity", icon: Activity },
  ];

  const mobileOverflowItems = useMemo(() => {
    const items = [
      {
        path: "/flows",
        label: "Flows",
        icon: Workflow,
        permission: "accessPlaylists",
      },
      ...(bootstrap?.ticketmasterConfigured
        ? [{ path: "/shows/all", label: "Shows", icon: Ticket }]
        : []),
    ];
    return items.filter(
      (item) =>
        !item.permission || user?.role === "admin" || !!user?.permissions?.[item.permission],
    );
  }, [bootstrap?.ticketmasterConfigured, user]);

  const handleMobileBack = useCallback(() => {
    if ((window.history.state?.idx ?? 0) > 0) {
      navigate(-1);
      return;
    }
    navigate("/");
  }, [navigate]);

  useEdgeSwipeBack(mainWrapRef, {
    enabled: !sectionRoot,
    onBack: handleMobileBack,
    resetKey: location.key,
  });

  const persistSidebarWidth = useCallback((width: number) => {
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

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      persistSidebarWidth(SIDEBAR_DEFAULT);
    },
    [persistSidebarWidth],
  );

  const updateScrollFromPointer = useCallback(
    (clientY: number) => {
      const node = mainScrollRef.current;
      const track = scrollbarTrackRef.current;
      const session = scrollbarDragRef.current;
      if (!node || !track || !session) return;
      const rect = track.getBoundingClientRect();
      const maxThumbTop = Math.max(rect.height - scrollbar.height, 0);
      const thumbTop = Math.min(Math.max(clientY - rect.top - session.grabOffset, 0), maxThumbTop);
      const scrollRange = Math.max(node.scrollHeight - node.clientHeight, 0);
      node.scrollTop = maxThumbTop > 0 ? (thumbTop / maxThumbTop) * scrollRange : 0;
    },
    [scrollbar.height],
  );

  const handleScrollbarPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
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
  }, []);

  const handleScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (scrollbarDragRef.current?.pointerId !== event.pointerId) return;
      updateScrollFromPointer(event.clientY);
    },
    [updateScrollFromPointer],
  );

  const handleScrollbarPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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
    if (!navBeta || !sectionRoot) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const step = event.key === "[" ? -1 : event.key === "]" ? 1 : 0;
      if (!step || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
      ) {
        return;
      }
      if (document.querySelector("[aria-modal='true']")) return;
      const { items } = sectionRoot;
      const next = items[items.findIndex((item) => item.active) + step];
      if (!next) return;
      event.preventDefault();
      navigate(next.path, { replace: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navBeta, navigate, sectionRoot]);

  useEffect(() => {
    const activeChip = sectionBarRef.current?.querySelector('[aria-current="page"]');
    activeChip?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [location.pathname, location.search, sectionRoot?.id]);

  useEffect(() => {
    let frameId: number | undefined;
    let timeoutId: number | undefined;
    if (isMobileMenuOpen) {
      setMobileMenuPresence("opening");
      frameId = window.requestAnimationFrame(() => setMobileMenuPresence("open"));
    } else {
      setMobileMenuPresence((current) => (current === "closed" ? current : "closing"));
      timeoutId = window.setTimeout(() => setMobileMenuPresence("closed"), MOBILE_SHEET_EXIT_MS);
    }
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [isMobileMenuOpen]);

  useEffect(() => {
    const node = mainScrollRef.current;
    const previous = scrolledPageRef.current;
    scrolledPageRef.current = { pathname: location.pathname, search: pageSearch };
    const samePath = previous?.pathname === location.pathname;
    const samePage = samePath && previous?.search === pageSearch;
    if ((navigationType === "REPLACE" && samePath) || samePage) {
      if (node) scrollPositionsRef.current.set(location.key, node.scrollTop);
      return undefined;
    }
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const savedTop =
      navigationType === "POP" ? scrollPositionsRef.current.get(location.key) || 0 : 0;
    let frameId: number | undefined;
    const startedAt = performance.now();
    const restore = () => {
      if (!node) return;
      const reachable = node.scrollHeight - node.clientHeight >= savedTop;
      node.scrollTo({ top: savedTop, left: 0, behavior: "auto" });
      if (!reachable && performance.now() - startedAt < 4000) {
        frameId = window.requestAnimationFrame(restore);
        return;
      }
      updateMainScrollbar();
    };
    restore();
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, [location.key, location.pathname, navigationType, pageSearch, updateMainScrollbar]);

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
      data-player-docked={!playerMinimized || undefined}
      data-nav={navBeta ? "beta" : undefined}
      style={{
        "--sidebar-width": `${sidebarWidth}px`,
      }}
    >
      <Sidebar
        mode={sidebarMode}
        width={sidebarWidth}
        onToggle={toggleSidebarPin}
        onRestorePlayer={playerMinimized ? () => changePlayerMinimized(false) : null}
      />

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
          {!sectionRoot ? (
            <button
              type="button"
              className="app-mobile-back"
              onClick={handleMobileBack}
              aria-label="Go back"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          ) : null}

          {navBeta && sectionNav ? (
            <nav className="app-topbar-tabs" aria-label={sectionNav.label}>
              {sidebarMode === "icons" ? (
                <span className="app-topbar-tabs__title">{sectionNav.title}</span>
              ) : null}
              {sectionNav.items.map((item) => (
                <RouteLink
                  key={item.id}
                  to={item.path}
                  replace={sectionNav.root}
                  className={`app-topbar-tabs__tab${item.active ? " is-active" : ""}`}
                  aria-current={item.active ? "page" : undefined}
                >
                  {item.label}
                </RouteLink>
              ))}
            </nav>
          ) : null}

          <GlobalSearch />

          <div className="app-header-actions">
            <InboxMenu />
            <UserProfileMenu />
            {headerActions}
          </div>
        </header>

        {sectionRoot ? (
          <nav ref={sectionBarRef} className="app-section-bar" aria-label={sectionRoot.label}>
            {sectionRoot.items.map((item) => (
              <RouteLink
                key={item.id}
                to={item.path}
                replace
                className={`app-section-bar__chip${item.active ? " is-active" : ""}`}
                aria-current={item.active ? "page" : undefined}
              >
                {item.label}
              </RouteLink>
            ))}
          </nav>
        ) : null}

        <div
          ref={mainWrapRef}
          className="app-main-wrap"
          data-scrolled={isMainScrolled || undefined}
        >
          <main
            className={`app-main${isArtistDetailsRoute ? " app-main--artist-details" : ""}`}
            ref={mainScrollRef}
            onScroll={(event) => {
              scrollPositionsRef.current.set(location.key, event.currentTarget.scrollTop);
              setIsMainScrolled(event.currentTarget.scrollTop > 0);
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

        <GlobalPlayerBar minimized={playerMinimized} onMinimizedChange={changePlayerMinimized} />

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
              <span className="app-mobile-menu__handle" aria-hidden="true" />
              <nav className="app-mobile-menu__nav">
                {mobileOverflowItems.map((item, index) => {
                  const Icon = item.icon;
                  const active = isActive(item.path);
                  return (
                    <RouteLink
                      key={item.path}
                      ref={index === 0 ? mobileMenuInitialFocusRef : undefined}
                      to={item.path}
                      className={`app-mobile-menu__item${active ? " is-active" : ""}`}
                      aria-current={active ? "page" : undefined}
                    >
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </RouteLink>
                  );
                })}
                <SettingsLink to="" className="app-mobile-menu__item" onClick={closeMobileMenu}>
                  <Settings aria-hidden="true" />
                  <span>Settings</span>
                </SettingsLink>
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
                <RouteLink
                  key={item.path}
                  to={item.path}
                  className={`app-mobile-nav__item${active ? " is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => {
                    const main = mainScrollRef.current;
                    if (location.pathname + location.search !== item.path || !main?.scrollTop) {
                      return;
                    }
                    event.preventDefault();
                    main.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </RouteLink>
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
      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      ) : null}
    </div>
  );
}

export default Layout;
