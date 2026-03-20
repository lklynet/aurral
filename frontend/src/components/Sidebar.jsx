import { Link, useLocation } from "react-router-dom";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import {
  Library,
  Settings,
  Sparkles,
  History,
  AudioWaveform,
  Ban,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import LogoutButton from "./LogoutButton";

function Sidebar({ isOpen, onClose, appVersion }) {
  const location = useLocation();
  const { authRequired, logout, user } = useAuth();
  const resolvedVersion =
    appVersion || import.meta.env.VITE_APP_VERSION || "unknown";
  const navRef = useRef(null);
  const activeBubbleRef = useRef(null);
  const hoverBubbleRef = useRef(null);
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const linkRefs = useRef({});

  const isActive = useCallback(
    (path) => {
      if (path === "/discover" && location.pathname === "/") return true;
      return location.pathname === path;
    },
    [location.pathname]
  );

  const navItems = useMemo(() => {
    const items = [
      { path: "/discover", label: "Discover", icon: Sparkles },
      { path: "/library", label: "Library", icon: Library },
      {
        path: "/flow",
        label: "Flow",
        icon: AudioWaveform,
        permission: "accessFlow",
      },
      { path: "/blocklist", label: "Blocklist", icon: Ban },
      { path: "/requests", label: "Requests", icon: History },
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
        !!user?.permissions?.[item.permission]
    );
  }, [user]);

  useEffect(() => {
    const updateBubblePosition = () => {
      if (!navRef.current || !activeBubbleRef.current) return;

      const activeIndex = navItems.findIndex((item) => isActive(item.path));
      if (activeIndex === -1) {
        activeBubbleRef.current.style.opacity = "0";
        return;
      }

      const activeLink = linkRefs.current[activeIndex];
      if (!activeLink) {
        setTimeout(updateBubblePosition, 50);
        return;
      }

      const navRect = navRef.current.getBoundingClientRect();
      const linkRect = activeLink.getBoundingClientRect();

      activeBubbleRef.current.style.left = `${linkRect.left - navRect.left}px`;
      activeBubbleRef.current.style.top = `${linkRect.top - navRect.top}px`;
      activeBubbleRef.current.style.width = `${linkRect.width}px`;
      activeBubbleRef.current.style.height = `${linkRect.height}px`;
      activeBubbleRef.current.style.opacity = "1";
    };

    const timeoutId = setTimeout(updateBubblePosition, 10);
    window.addEventListener("resize", updateBubblePosition);
    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("resize", updateBubblePosition);
    };
  }, [location.pathname, navItems, isOpen, isActive]);

  useEffect(() => {
    const updateHoverBubble = () => {
      if (!navRef.current || !hoverBubbleRef.current) return;

      if (hoveredIndex === null) {
        hoverBubbleRef.current.style.left = "0px";
        hoverBubbleRef.current.style.top = "0px";
        hoverBubbleRef.current.style.width = "100%";
        hoverBubbleRef.current.style.height = "100%";
        hoverBubbleRef.current.style.opacity = "0.6";
        return;
      }

      const hoveredLink = linkRefs.current[hoveredIndex];
      if (!hoveredLink) return;

      const navRect = navRef.current.getBoundingClientRect();
      const linkRect = hoveredLink.getBoundingClientRect();

      hoverBubbleRef.current.style.left = `${linkRect.left - navRect.left}px`;
      hoverBubbleRef.current.style.top = `${linkRect.top - navRect.top}px`;
      hoverBubbleRef.current.style.width = `${linkRect.width}px`;
      hoverBubbleRef.current.style.height = `${linkRect.height}px`;
      hoverBubbleRef.current.style.opacity = "1";
    };

    updateHoverBubble();
  }, [hoveredIndex]);

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-52 flex flex-col transition-transform duration-300 ease-in-out pl-safe pt-safe pb-safe ${
          isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
        style={{ backgroundColor: "#18181c" }}
      >
        <div className="h-16 flex items-center justify-center px-4">
          <Link to="/" className="flex items-center space-x-2 group">
            <img
              src="/arralogo.svg"
              alt="Aurral Logo"
              className="w-7 h-7 transition-transform group-hover:scale-110"
              style={{
                filter:
                  "brightness(0) saturate(100%) invert(45%) sepia(8%) saturate(800%) hue-rotate(60deg) brightness(95%) contrast(85%)",
              }}
            />
            <span
              className="text-lg font-bold tracking-tight transition-colors"
              style={{ color: "#fff" }}
            >
              Aurral
            </span>
          </Link>
        </div>

        <div className="flex-1 px-3 py-6 overflow-y-auto flex items-start justify-center">
          <div
            ref={navRef}
            className="relative p-3"
            style={{ backgroundColor: "#0f0f12" }}
          >
            <div
              ref={activeBubbleRef}
              className="absolute transition-all duration-300 ease-out z-10 opacity-0"
              style={{ backgroundColor: "#707e61", opacity: "0.2" }}
            />

            <div
              ref={hoverBubbleRef}
              className="absolute transition-all duration-200 ease-out z-0"
              style={{ backgroundColor: "#1a1a1e" }}
            />

            <nav
              className="relative flex flex-col space-y-2"
              onMouseLeave={() => setHoveredIndex(null)}
            >
              {navItems.map((item, index) => {
                const Icon = item.icon;
                const active = isActive(item.path);
                const highlighted = active || hoveredIndex === index;
                const linkColor = highlighted ? "#fff" : "#c1c1c3";

                return (
                  <Link
                    key={item.path}
                    ref={(el) => {
                      if (el) linkRefs.current[index] = el;
                    }}
                    to={item.path}
                    onMouseEnter={() => setHoveredIndex(index)}
                    className="relative z-20 flex items-center space-x-3 px-4 py-3.5 font-medium transition-all duration-200 text-base"
                    style={{ color: linkColor }}
                  >
                    <Icon
                      className="w-5 h-5 transition-transform group-hover:scale-110 flex-shrink-0"
                      style={{ color: linkColor }}
                    />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 p-3 mt-auto border-t" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
          {authRequired && (
            <LogoutButton onClick={logout} />
          )}
          
          <div className="text-[10px] font-mono opacity-30 select-none" style={{ color: "#c1c1c3" }}>
            v{resolvedVersion}
          </div>
        </div>
      </aside>
    </>
  );
}

Sidebar.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  appVersion: PropTypes.string,
};

export default Sidebar;
