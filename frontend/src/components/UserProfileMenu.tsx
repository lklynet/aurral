import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import { SettingsLink } from "../pages/Settings/settingsRoute";
import { BellRinging, User, Heart, LogOut, ExternalLink, GitHub, Settings } from "./icons";
import { useAuth } from "../contexts/AuthContext";
import { useWrappedSeason } from "../hooks/useWrapped.ts";
import { useStorageHealth } from "../hooks/useStorageHealth";
import TooltipButton from "./TooltipButton";

function UserProfileMenu() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { authRequired, canLogOut, logout, user } = useAuth();
  const wrappedSeason = useWrappedSeason();
  const { hasFailure: hasStorageFailure } = useStorageHealth({
    enabled: user?.role === "admin" || !!user?.permissions?.accessSettings,
  });

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target instanceof Node ? event.target : null)
      ) {
        setMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

  return (
    <div ref={menuRef} className="app-profile-menu">
      <TooltipButton
        ref={triggerRef}
        label={hasStorageFailure ? "User menu (storage issues)" : "User menu"}
        onClick={() => setMenuOpen((open) => !open)}
        className={`app-header-link app-profile-menu__trigger${menuOpen ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <span className="app-profile-menu__icon" aria-hidden="true">
          <User />
          {hasStorageFailure ? <span className="app-profile-menu__alert" /> : null}
        </span>
      </TooltipButton>

      {menuOpen && (
        <div className="app-profile-menu__dropdown" role="menu">
          <ul className="app-profile-menu__list">
            {wrappedSeason && (
              <li role="none">
                <Link
                  to="/wrapped"
                  state={{ wrappedFrom: `${location.pathname}${location.search}${location.hash}` }}
                  role="menuitem"
                  className="app-profile-menu__item"
                  onClick={closeMenu}
                >
                  <BellRinging className="app-profile-menu__item-icon" />
                  <span>Your Wrapped</span>
                </Link>
              </li>
            )}
            <li role="none">
              <SettingsLink
                to="profile"
                role="menuitem"
                className="app-profile-menu__item"
                onClick={closeMenu}
              >
                <User className="app-profile-menu__item-icon" />
                <span>Profile</span>
              </SettingsLink>
            </li>
            <li role="none">
              <SettingsLink
                to={hasStorageFailure ? "status" : ""}
                role="menuitem"
                className="app-profile-menu__item"
                onClick={closeMenu}
              >
                <Settings className="app-profile-menu__item-icon" />
                <span>Settings</span>
                {hasStorageFailure ? (
                  <>
                    <span
                      className="app-profile-menu__alert app-profile-menu__alert--item"
                      aria-hidden="true"
                    />
                    <span className="sr-only"> (storage issues)</span>
                  </>
                ) : null}
              </SettingsLink>
            </li>
            <li role="none">
              <a
                href="https://docs.aurral.org/sponsorship/"
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                className="app-profile-menu__item"
                onClick={closeMenu}
              >
                <Heart className="app-profile-menu__item-icon" />
                <span>Donate</span>
                <ExternalLink className="app-profile-menu__item-external" />
              </a>
            </li>
            <li role="none">
              <a
                href="https://github.com/lklynet/aurral"
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                className="app-profile-menu__item"
                onClick={closeMenu}
              >
                <GitHub className="app-profile-menu__item-icon" />
                <span>GitHub</span>
                <ExternalLink className="app-profile-menu__item-external" />
              </a>
            </li>
            {authRequired && canLogOut && (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="app-profile-menu__item app-profile-menu__item--danger"
                  onClick={() => {
                    closeMenu();
                    logout();
                  }}
                >
                  <LogOut className="app-profile-menu__item-icon" />
                  <span>Log out</span>
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export default UserProfileMenu;
