import { useLocation } from "react-router";
import RouteLink from "./RouteLink";
import { useState, useEffect, useCallback, useMemo, type SyntheticEvent } from "react";
import {
  Activity,
  AudioWaveform,
  Library,
  Menu,
  Sparkles,
  Ticket,
  type IconComponent,
} from "./icons";
import { useAuth } from "../contexts/AuthContext";
import { useDownloadWorkerActivity } from "../hooks/useDownloadWorkerActivity";
import { DEFAULT_SHOWS_FILTER } from "../navigation/showsNavConfig";
import { DEFAULT_ACTIVITY_VIEW, buildActivityPath } from "../navigation/activityNavConfig";
import { useSiteLogo } from "../hooks/useSiteLogo";
import TooltipButton from "./TooltipButton";
import SidebarPlayer from "./SidebarPlayer";
import SidebarPlaylists from "./SidebarPlaylists";
import { useSectionNav } from "../navigation/useSectionNav.ts";
import SidebarStageBackdrop, {
  getSidebarStageBackdropEnabled,
  resolveSidebarStageBackdropVariant,
  SIDEBAR_STAGE_BACKDROP_EVENT,
} from "./SidebarStageBackdrop";

type SidebarProps = {
  mode: "hidden" | "icons" | "full";
  width?: number;
  onToggle: () => void;
  onRestorePlayer: (() => void) | null;
};

type SidebarNavItem = {
  path: string;
  label: string;
  icon: IconComponent;
  section?: string;
  permission?: string;
};

function Sidebar({ mode, width = 208, onToggle, onRestorePlayer }: SidebarProps) {
  const location = useLocation();
  const { user, bootstrap } = useAuth();
  const logo = useSiteLogo();
  const [showStageBackdrop, setShowStageBackdrop] = useState(() =>
    getSidebarStageBackdropEnabled(user?.id),
  );
  const stageBackdropVariant = showStageBackdrop ? resolveSidebarStageBackdropVariant() : null;
  const sectionId = useSectionNav()?.id;
  const hasFlowAccess = user?.role === "admin" || !!user?.permissions?.accessPlaylists;
  const { hasReview: hasReviewAlert, status: playlistStatus } = useDownloadWorkerActivity({
    enabled: hasFlowAccess,
  });
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : true,
  );
  const [ticketmasterConfigured, setTicketmasterConfigured] = useState(true);

  useEffect(() => {
    setShowStageBackdrop(getSidebarStageBackdropEnabled(user?.id));
    const onPreferenceChange = (event: Event) => {
      if ((event as CustomEvent<{ userId?: number | null }>).detail?.userId === user?.id) {
        setShowStageBackdrop(getSidebarStageBackdropEnabled(user?.id));
      }
    };
    window.addEventListener(SIDEBAR_STAGE_BACKDROP_EVENT, onPreferenceChange);
    return () => window.removeEventListener(SIDEBAR_STAGE_BACKDROP_EVENT, onPreferenceChange);
  }, [user?.id]);

  const isIcons = mode === "icons" && isDesktop;
  const positionSidebarTooltip = useCallback((event: SyntheticEvent<HTMLElement>) => {
    const link = event.currentTarget;
    const rect = link.getBoundingClientRect();
    link.style.setProperty("--sidebar-tooltip-top", `${rect.top + rect.height / 2}px`);
    link.style.setProperty("--sidebar-tooltip-left", `${rect.right + 8}px`);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
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

  const isNavItemActive = (item: SidebarNavItem) =>
    item.section
      ? item.section === sectionId
      : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);

  const navItems = useMemo(() => {
    const items: SidebarNavItem[] = [
      { path: "/", label: "Discover", icon: Sparkles, section: "discover" },
      { path: "/library", label: "Library", icon: Library, section: "library" },
      { path: "/flows", label: "Flows", icon: AudioWaveform, permission: "accessPlaylists" },
      ...(ticketmasterConfigured
        ? [
            {
              path: `/shows/${DEFAULT_SHOWS_FILTER}`,
              label: "Shows",
              icon: Ticket,
              section: "shows",
            },
          ]
        : []),
      {
        path: buildActivityPath(DEFAULT_ACTIVITY_VIEW),
        label: "Activity",
        icon: Activity,
        section: "activity",
      },
    ];
    return items.filter(
      (item) =>
        !item.permission || user?.role === "admin" || !!user?.permissions?.[item.permission],
    );
  }, [ticketmasterConfigured, user]);

  const translateClass = mode === "hidden" ? "-translate-x-full" : "translate-x-0";

  return (
    <>
      <div
        className={`sidebar-brand${stageBackdropVariant ? ` sidebar-brand--${stageBackdropVariant}` : ""}${isIcons ? " sidebar-brand--icons" : ""}`}
      >
        {stageBackdropVariant ? <SidebarStageBackdrop variant={stageBackdropVariant} /> : null}
        <TooltipButton
          label={isIcons ? "Expand sidebar" : "Collapse to icons"}
          type="button"
          onClick={onToggle}
          className="app-nav-toggle"
        >
          <Menu aria-hidden="true" />
        </TooltipButton>
        <RouteLink to="/" className="sidebar-logo-link">
          <img src={logo.src} alt="Aurral logo" className={`sidebar-logo${logo.className}`} />
          <span className="sidebar-title">Aurral</span>
        </RouteLink>
      </div>
      <aside
        className={`sidebar-shell ${isIcons ? "sidebar-shell--icons" : "sidebar-shell--full"} sidebar-shell--new ${translateClass}`}
        aria-label="Primary navigation"
        style={{
          width: `${width}px`,
        }}
      >
        <div className={`sidebar-body${isIcons ? " sidebar-body--icons" : ""}`}>
          <div className={`sidebar-nav-wrap${isIcons ? " sidebar-nav-wrap--icons" : ""}`}>
            <nav className="sidebar-nav">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isNavItemActive(item);
                const showActivityDot = item.section === "activity" && hasReviewAlert;

                return (
                  <div
                    key={item.path}
                    className={`sidebar-nav-group${active ? " is-active-row" : ""}`}
                  >
                    <RouteLink
                      to={item.path}
                      onMouseEnter={(event) => {
                        if (isIcons) positionSidebarTooltip(event);
                      }}
                      onFocus={(event) => {
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
                      aria-current={active ? "page" : undefined}
                    >
                      <span className="sidebar-link__icon-wrap">
                        <Icon className="sidebar-link__icon" aria-hidden="true" />
                        {showActivityDot ? (
                          <span
                            className="sidebar-link__activity sidebar-link__activity--review"
                            aria-hidden="true"
                          />
                        ) : null}
                      </span>
                      {!isIcons && (
                        <span className="sidebar-link__label">
                          {item.label}
                          {showActivityDot ? <span className="sr-only"> (active)</span> : null}
                        </span>
                      )}
                      {isIcons && <span className="sidebar-tooltip">{item.label}</span>}
                    </RouteLink>
                  </div>
                );
              })}
            </nav>
          </div>

          {hasFlowAccess ? (
            <SidebarPlaylists
              status={playlistStatus}
              iconsOnly={isIcons}
              onTooltip={isIcons ? positionSidebarTooltip : undefined}
            />
          ) : null}

          {onRestorePlayer ? (
            <div className="sidebar-player-group">
              <SidebarPlayer
                iconsOnly={isIcons}
                onRestore={onRestorePlayer}
                onTooltip={isIcons ? positionSidebarTooltip : undefined}
              />
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}

export default Sidebar;
