import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import { Link, useLocation } from "react-router-dom";
import {
  Menu,
  Sparkles,
  Library,
  History,
  Ellipsis,
  Ticket,
  AudioWaveform,
  Download,
  Ban,
  Settings,
  LogOut,
  User,
} from "lucide-react";
import Sidebar from "./Sidebar";
import GlobalSearch from "./GlobalSearch";
import GlobalPlayerBar from "./GlobalPlayerBar";
import UserProfileMenu from "./UserProfileMenu";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../hooks/useAudioQueue";

const VALID_SIDEBAR_MODES = ["full", "icons", "hidden"];

function Layout({ children, appVersion }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [scrollbar, setScrollbar] = useState({
    visible: false,
    active: false,
    top: 0,
    height: 0,
  });
  const mainScrollRef = useRef(null);
  const scrollbarFadeTimeoutRef = useRef(null);
  const [sidebarMode, setSidebarMode] = useState(() => {
    try {
      const stored = localStorage.getItem("sidebarMode");
      if (stored === "hidden") {
        const visible = localStorage.getItem("sidebarVisibleMode");
        return visible === "full" || visible === "icons" ? visible : "icons";
      }
      return VALID_SIDEBAR_MODES.includes(stored) ? stored : "full";
    } catch {
      return "full";
    }
  });
  const location = useLocation();
  const { authRequired, logout, user } = useAuth();
  const { isActive: isPlayerActive } = useAudioQueue();
  const isArtistDetailsRoute = /^\/artist\/[^/]+$/.test(location.pathname);

  const updateMainScrollbar = useCallback(() => {
    const node = mainScrollRef.current;
    if (!node) return;
    const { scrollTop, scrollHeight, clientHeight } = node;
    const scrollable = scrollHeight > clientHeight + 1;
    if (!scrollable) {
      setScrollbar((current) =>
        current.visible
          ? { visible: false, active: false, top: 0, height: 0 }
          : current,
      );
      return;
    }
    const minThumbHeight = 48;
    const thumbHeight = Math.max(
      minThumbHeight,
      (clientHeight / scrollHeight) * clientHeight,
    );
    const maxTop = Math.max(clientHeight - thumbHeight, 0);
    const top =
      scrollHeight === clientHeight
        ? 0
        : (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    setScrollbar((current) => ({
      visible: true,
      active: current.active,
      top,
      height: thumbHeight,
    }));
  }, []);

  const showScrollbarTemporarily = useCallback(() => {
    setScrollbar((current) =>
      current.visible ? { ...current, active: true } : current,
    );
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
      return location.pathname === path;
    },
    [location.pathname],
  );

  const mobilePrimaryItems = useMemo(
    () => [
      { path: "/discover", label: "Discover", icon: Sparkles },
      { path: "/library", label: "Library", icon: Library },
      { path: "/requests", label: "Requests", icon: History },
    ],
    [],
  );

  const mobileOverflowItems = useMemo(() => {
    const items = [
      { path: "/shows", label: "Shows", icon: Ticket },
      {
        path: "/playlists",
        label: "Playlists",
        icon: AudioWaveform,
        permission: "accessFlow",
      },
      {
        path: "/downloads",
        label: "Downloads",
        icon: Download,
        permission: "accessFlow",
      },
      { path: "/blocklist", label: "Blocklist", icon: Ban },
      { path: "/profile", label: "Profile", icon: User },
      {
        path: "/settings",
        label: "Settings",
        icon: Settings,
        permission: "accessSettings",
      },
    ];
    return items.filter(
      (item) =>
        !item.permission ||
        user?.role === "admin" ||
        !!user?.permissions?.[item.permission],
    );
  }, [user]);

  const handleSetSidebarMode = useCallback((newMode) => {
    setSidebarMode(newMode);
    try {
      localStorage.setItem("sidebarMode", newMode);
      localStorage.setItem("sidebarVisibleMode", newMode);
    } catch {}
  }, []);

  const toggleSidebarPin = useCallback(() => {
    handleSetSidebarMode(sidebarMode === "icons" ? "full" : "icons");
  }, [handleSetSidebarMode, sidebarMode]);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

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
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
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
    <div className="app-shell">
      <Sidebar appVersion={appVersion} mode={sidebarMode} />

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
            aria-label={
              sidebarMode === "icons" ? "Expand sidebar" : "Collapse to icons"
            }
            title={
              sidebarMode === "icons" ? "Expand sidebar" : "Collapse to icons"
            }
          >
            <Menu aria-hidden="true" />
          </button>

          <GlobalSearch />

          <div className="app-header-actions">
            <UserProfileMenu />
          </div>
        </header>

        <div className="app-main-wrap">
          <main
            className={`app-main${isArtistDetailsRoute ? " app-main--artist-details" : ""}`}
            ref={mainScrollRef}
            onScroll={() => {
              updateMainScrollbar();
              showScrollbarTemporarily();
            }}
          >
            <div className="app-main__content">{children}</div>
          </main>
          <div
            className={`app-main-scrollbar${scrollbar.visible ? " is-visible" : ""}${
              scrollbar.active ? " is-active" : ""
            }`}
            aria-hidden="true"
          >
            <div
              className="app-main-scrollbar__thumb"
              style={{
                height: `${scrollbar.height}px`,
                transform: `translateY(${scrollbar.top}px)`,
              }}
            />
          </div>
        </div>

        <GlobalPlayerBar />

        {isMobileMenuOpen && (
          <>
            <button
              type="button"
              className="app-mobile-backdrop app-mobile-only"
              onClick={() => setIsMobileMenuOpen(false)}
              aria-label="Close navigation menu"
            />
            <div className="app-mobile-menu app-mobile-only">
              <nav className="app-mobile-menu__nav">
                {mobileOverflowItems.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.path);
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={`app-mobile-menu__item${active ? " is-active" : ""}`}
                    >
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
                {authRequired && (
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
          </>
        )}

        <nav
          className="app-mobile-nav app-mobile-only"
          aria-label="Mobile navigation"
        >
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
                isMobileMenuOpen ||
                mobileOverflowItems.some((item) => isActive(item.path))
                  ? " is-active"
                  : ""
              }`}
              aria-label="More navigation options"
              aria-expanded={isMobileMenuOpen}
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

Layout.propTypes = {
  children: PropTypes.node.isRequired,
  appVersion: PropTypes.string,
};

export default Layout;
