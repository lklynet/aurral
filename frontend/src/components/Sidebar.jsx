import { Link, useLocation } from "react-router-dom";
import { useState, useEffect, useCallback, useMemo } from "react";
import { ArrowLeft, Ban, Library, Sparkles, Activity, AudioWaveform, Ticket, Settings } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { useFlowWorkerActivity } from "../pages/flows/useFlowWorkerActivity";
import { DEFAULT_SETTINGS_TAB, SETTINGS_NAV_TABS } from "../pages/Settings/settingsTabsConfig";
import { DEFAULT_SHOWS_FILTER, SHOWS_FILTERS } from "../navigation/showsNavConfig";
import {
  ACTIVITY_VIEWS,
  DEFAULT_ACTIVITY_VIEW,
  buildActivityPath,
} from "../navigation/activityNavConfig";
import { useDiscoverRecent } from "../contexts/DiscoverRecentProvider";
import {
  getDiscoverArtistPath,
  getDiscoverRecentPageLinkState,
} from "../utils/discoverRecentNavigation";
import { useStorageHealth } from "../hooks/useStorageHealth";
import SidebarStageBackdrop, {
  resolveSidebarStageBackdropVariant,
} from "./SidebarStageBackdrop";

function Sidebar({ mode, width = 208, settingsMode = false }) {
  const stageBackdropVariant = resolveSidebarStageBackdropVariant();
  const location = useLocation();
  const { user, bootstrap } = useAuth();
  const hasFlowAccess = user?.role === "admin" || !!user?.permissions?.accessFlow;
  const canAccessSettings = user?.role === "admin" || !!user?.permissions?.accessSettings;
  const { hasReview: hasReviewAlert } = useFlowWorkerActivity({
    enabled: hasFlowAccess,
  });
  const { hasFailure: hasStorageFailure } = useStorageHealth({
    enabled: canAccessSettings,
  });
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : true,
  );
  const [ticketmasterConfigured, setTicketmasterConfigured] = useState(true);
  const {
    recentPages: discoverRecentPages,
    clearRecentPages,
    isDiscoverSectionActive,
  } = useDiscoverRecent();

  const isIcons = mode === "icons" && isDesktop;
  const currentDiscoverPath = `${location.pathname}${location.search}`;
  const activeDiscoverRecentPath =
    getDiscoverArtistPath(currentDiscoverPath) || currentDiscoverPath;
  const isOnSettings = location.pathname.startsWith("/settings");
  const isOnShows = location.pathname.startsWith("/shows");
  const isOnActivity =
    location.pathname.startsWith("/activity") || location.pathname.startsWith("/history");

  const settingsTabs = useMemo(() => {
    if (!canAccessSettings) return [];
    return SETTINGS_NAV_TABS;
  }, [canAccessSettings]);

  const activeSettingsTab = useMemo(() => {
    if (!isOnSettings) return null;
    const segment = location.pathname.replace(/^\/settings\/?/, "").split("/")[0];
    return segment || DEFAULT_SETTINGS_TAB;
  }, [isOnSettings, location.pathname]);

  const activeShowsFilter = useMemo(() => {
    if (!isOnShows) return null;
    const segment = location.pathname.replace(/^\/shows\/?/, "").split("/")[0];
    return segment || DEFAULT_SHOWS_FILTER;
  }, [isOnShows, location.pathname]);

  const activeActivityView = useMemo(() => {
    if (!isOnActivity) return null;
    if (location.pathname.startsWith("/history")) {
      const legacySegment = location.pathname.replace(/^\/history\/?/, "").split("/")[0];
      if (legacySegment === "queue" || legacySegment === "history") {
        return legacySegment;
      }
      return "history";
    }
    const segment = location.pathname.replace(/^\/activity\/?/, "").split("/")[0];
    return segment || DEFAULT_ACTIVITY_VIEW;
  }, [isOnActivity, location.pathname]);

  const positionSidebarTooltip = useCallback((event) => {
    const link = event.currentTarget;
    const rect = link.getBoundingClientRect();
    link.style.setProperty("--sidebar-tooltip-top", `${rect.top + rect.height / 2}px`);
    link.style.setProperty("--sidebar-tooltip-left", `${rect.right + 8}px`);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const onChange = (event) => setIsDesktop(event.matches);
    setIsDesktop(mediaQuery.matches);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", onChange);
      return () => mediaQuery.removeEventListener("change", onChange);
    }
    mediaQuery.addListener(onChange);
    return () => mediaQuery.removeListener(onChange);
  }, []);

  useEffect(() => {
    if (bootstrap) {
      setTicketmasterConfigured(!!bootstrap.ticketmasterConfigured);
    }
  }, [bootstrap]);

  const isNavItemActive = useCallback(
    (item) => {
      if (item.section === "discover") {
        return isDiscoverSectionActive;
      }
      if (item.section === "shows") return isOnShows;
      if (item.section === "activity") return isOnActivity;
      if (item.path === "/discover" && location.pathname === "/") return true;
      return location.pathname === item.path;
    },
    [isDiscoverSectionActive, isOnActivity, isOnShows, location.pathname],
  );

  const navItems = useMemo(() => {
    const items = [
      {
        path: "/discover",
        label: "Discover",
        icon: Sparkles,
        section: "discover",
        subnav: discoverRecentPages,
      },
      { path: "/library", label: "Library", icon: Library },
      ...(ticketmasterConfigured
        ? [
            {
              path: `/shows/${DEFAULT_SHOWS_FILTER}`,
              basePath: "/shows",
              label: "Shows",
              icon: Ticket,
              section: "shows",
              subnav: SHOWS_FILTERS,
            },
          ]
        : []),
      {
        path: "/playlists",
        label: "Playlists",
        icon: AudioWaveform,
        permission: "accessFlow",
      },
      {
        path: buildActivityPath(DEFAULT_ACTIVITY_VIEW),
        basePath: "/activity",
        label: "Activity",
        icon: Activity,
        section: "activity",
        subnav: ACTIVITY_VIEWS,
      },
      { path: "/blocklist", label: "Blocklist", icon: Ban },
    ];
    return items.filter(
      (item) =>
        !item.permission || user?.role === "admin" || !!user?.permissions?.[item.permission],
    );
  }, [discoverRecentPages, ticketmasterConfigured, user]);

  const translateClass = mode === "hidden" ? "-translate-x-full" : "translate-x-0";

  const renderSubnav = (item, activeId) => {
    if (isIcons || !isNavItemActive(item)) {
      return null;
    }
    if (!item.subnav?.length && item.section !== "discover") {
      return null;
    }

    if (item.section === "discover") {
      const isRecommendedActive =
        location.pathname === "/search" && location.search === "?type=recommended";
      const isTrendingActive =
        location.pathname === "/search" && location.search === "?type=trending";
      return (
        <nav className="sidebar-subnav" aria-label={`${item.label} views`}>
          <Link
            to="/discover/playlists"
            className={`sidebar-subnav-link${location.pathname.startsWith("/discover/playlists") ? " is-active" : ""}`}
            aria-current={location.pathname.startsWith("/discover/playlists") ? "page" : undefined}
          >
            Playlists
          </Link>
          <Link
            to="/search?type=recommended"
            className={`sidebar-subnav-link${isRecommendedActive ? " is-active" : ""}`}
            aria-current={isRecommendedActive ? "page" : undefined}
          >
            Recommended
          </Link>
          <Link
            to="/search?type=trending"
            className={`sidebar-subnav-link${isTrendingActive ? " is-active" : ""}`}
            aria-current={isTrendingActive ? "page" : undefined}
          >
            Trending
          </Link>
          {item.subnav.length > 0 && <hr className="sidebar-subnav-separator" />}
          {item.subnav.slice(0, 3).map((entry) => {
            const active = activeId === entry.id;
            return (
              <Link
                key={entry.id}
                to={entry.path}
                state={getDiscoverRecentPageLinkState(entry)}
                className={`sidebar-subnav-link sidebar-subnav-link--recent${
                  active ? " is-active" : ""
                }`}
                aria-current={active ? "page" : undefined}
                title={entry.label}
              >
                <span className="sidebar-subnav-link__text">{entry.label}</span>
              </Link>
            );
          })}
          {item.subnav.length > 0 && (
            <button type="button" className="sidebar-subnav-action" onClick={clearRecentPages}>
              Clear recent
            </button>
          )}
        </nav>
      );
    }

    return (
      <nav className="sidebar-subnav" aria-label={`${item.label} views`}>
        {item.subnav.map((entry) => {
          const active = activeId === entry.id;
          const targetPath =
            item.section === "activity"
              ? buildActivityPath(entry.id)
              : `${item.basePath}/${entry.id}`;
          const showReviewAlert = item.section === "activity" && entry.id === "review" && hasReviewAlert;
          return (
            <Link
              key={entry.id}
              to={targetPath}
              className={`sidebar-subnav-link${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {showReviewAlert ? (
                <span className="sidebar-subnav-link__alert" aria-hidden="true" />
              ) : null}
              <span>{entry.label}</span>
            </Link>
          );
        })}
      </nav>
    );
  };

  const getNavGroupClassName = (item, active) => {
    const classes = ["sidebar-nav-group"];
    if (item.section === "discover") {
      classes.push("sidebar-nav-group--discover");
    }
    if (active && (item.subnav?.length || item.section === "discover") && !isIcons) {
      classes.push("is-expanded");
    } else if (active) {
      classes.push("is-active-row");
    }
    return classes.join(" ");
  };

  const renderSettingsNav = () =>
    settingsTabs.map((tab) => {
      const Icon = tab.icon;
      const active = activeSettingsTab === tab.id;
      return (
        <div key={tab.id} className={`sidebar-nav-group${active ? " is-active-row" : ""}`}>
          <Link
            to={`/settings/${tab.id}`}
            onMouseEnter={(event) => {
              if (isIcons) positionSidebarTooltip(event);
            }}
            className={`sidebar-link ${isIcons ? "sidebar-link--icons" : "sidebar-link--full"}${
              active ? " is-active" : ""
            }`}
            aria-label={isIcons ? tab.label : undefined}
            aria-current={active ? "page" : undefined}
          >
            <span className="sidebar-link__icon-wrap">
              <Icon className="sidebar-link__icon" aria-hidden="true" />
            </span>
            {!isIcons && <span className="sidebar-link__label">{tab.label}</span>}
            {isIcons && <span className="sidebar-tooltip">{tab.label}</span>}
          </Link>
        </div>
      );
    });

  return (
    <aside
      className={`sidebar-shell ${isIcons ? "sidebar-shell--icons" : "sidebar-shell--full"} ${translateClass}${
        stageBackdropVariant ? ` sidebar-shell--${stageBackdropVariant}` : ""
      }`}
      aria-label={settingsMode ? "Settings navigation" : "Primary navigation"}
      style={{
        width: `${width}px`,
      }}
    >
      {stageBackdropVariant ? <SidebarStageBackdrop variant={stageBackdropVariant} /> : null}
      <div className="sidebar-logo-row">
        <Link to="/" className="sidebar-logo-link">
          <img src="/arralogo.svg" alt="Aurral Logo" className="sidebar-logo" />
          {!isIcons && <span className="sidebar-title">Aurral</span>}
        </Link>
      </div>

      <div className={`sidebar-body${isIcons ? " sidebar-body--icons" : ""}`}>
        <div className={`sidebar-nav-wrap${isIcons ? " sidebar-nav-wrap--icons" : ""}`}>
          <nav className="sidebar-nav">
            {settingsMode ? renderSettingsNav() : navItems.map((item) => {
              const Icon = item.icon;
              const active = isNavItemActive(item);
              const showActivityDot = item.section === "activity" && hasReviewAlert;
              const activeSubnavId =
                item.section === "discover"
                  ? discoverRecentPages.find((entry) => entry.path === activeDiscoverRecentPath)?.id
                  : item.section === "shows"
                    ? activeShowsFilter
                    : item.section === "activity"
                      ? activeActivityView
                      : null;

              return (
                <div key={item.path} className={getNavGroupClassName(item, active)}>
                  <Link
                    to={item.path}
                    onMouseEnter={(event) => {
                      if (isIcons) positionSidebarTooltip(event);
                    }}
                    className={`sidebar-link ${
                      isIcons ? "sidebar-link--icons" : "sidebar-link--full"
                    }${active ? " is-active" : ""}`}
                    aria-label={
                      isIcons
                        ? showActivityDot
                          ? `${item.label} (active)`
                          : item.label
                        : undefined
                    }
                  >
                    <span className="sidebar-link__icon-wrap">
                      <Icon className="sidebar-link__icon" aria-hidden="true" />
                      {showActivityDot ? (
                        <span className="sidebar-link__activity" aria-hidden="true" />
                      ) : null}
                    </span>
                    {!isIcons && (
                      <span className="sidebar-link__label">
                        {item.label}
                        {showActivityDot ? <span className="sr-only"> (active)</span> : null}
                      </span>
                    )}
                    {isIcons && <span className="sidebar-tooltip">{item.label}</span>}
                  </Link>
                  {renderSubnav(item, activeSubnavId)}
                </div>
              );
            })}
          </nav>
        </div>

        {canAccessSettings && (
          <div
            className={`sidebar-settings-group${
              isIcons || settingsMode ? "" : isOnSettings ? " sidebar-nav-group is-expanded" : ""
            }`}
          >
            {settingsMode ? (
              <Link
                to="/"
                onMouseEnter={positionSidebarTooltip}
                className={`sidebar-link sidebar-link--${isIcons ? "icons" : "full"}`}
                aria-label="Back to Aurral"
              >
                <span className="sidebar-link__icon-wrap">
                  <ArrowLeft className="sidebar-link__icon" aria-hidden="true" />
                </span>
                {!isIcons && <span className="sidebar-link__label">Back</span>}
                {isIcons && <span className="sidebar-tooltip">Back</span>}
              </Link>
            ) : isIcons ? (
              <Link
                to={`/settings/${DEFAULT_SETTINGS_TAB}`}
                onMouseEnter={positionSidebarTooltip}
                className={`sidebar-link sidebar-link--icons${isOnSettings ? " is-active" : ""}`}
                aria-label={hasStorageFailure ? "Settings (storage issues)" : "Settings"}
              >
                <span className="sidebar-link__icon-wrap">
                  <Settings className="sidebar-link__icon" aria-hidden="true" />
                  {hasStorageFailure ? (
                    <span
                      className="sidebar-link__activity sidebar-link__activity--alert"
                      aria-hidden="true"
                    />
                  ) : null}
                </span>
                <span className="sidebar-tooltip">Settings</span>
              </Link>
            ) : (
              <>
                <Link
                  to={`/settings/${DEFAULT_SETTINGS_TAB}`}
                  className={`sidebar-link sidebar-link--full${isOnSettings ? " is-active" : ""}`}
                >
                  <span className="sidebar-link__icon-wrap">
                    <Settings className="sidebar-link__icon" aria-hidden="true" />
                    {hasStorageFailure ? (
                      <span
                        className="sidebar-link__activity sidebar-link__activity--alert"
                        aria-hidden="true"
                      />
                    ) : null}
                  </span>
                  <span className="sidebar-link__label">
                    Settings
                    {hasStorageFailure ? <span className="sr-only"> (storage issues)</span> : null}
                  </span>
                </Link>

                {isOnSettings && (
                  <nav className="sidebar-subnav" aria-label="Settings sections">
                    {settingsTabs.map((tab) => {
                      const tabActive = activeSettingsTab === tab.id;
                      const showStorageAlert = tab.id === "system" && hasStorageFailure;
                      return (
                        <Link
                          key={tab.id}
                          to={`/settings/${tab.id}`}
                          className={`sidebar-subnav-link${tabActive ? " is-active" : ""}`}
                          aria-current={tabActive ? "page" : undefined}
                        >
                          {showStorageAlert ? (
                            <span className="sidebar-subnav-link__alert" aria-hidden="true" />
                          ) : null}
                          <span>{tab.label}</span>
                        </Link>
                      );
                    })}
                  </nav>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

export default Sidebar;
