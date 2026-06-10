import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { User, Settings, Heart, LogOut, ExternalLink } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";

function GitHubIcon({ className = "" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path d="M12 .5C5.649.5.5 5.649.5 12c0 5.084 3.292 9.398 7.861 10.919.575.106.786-.25.786-.556 0-.274-.01-1-.016-1.962-3.197.695-3.872-1.541-3.872-1.541-.523-1.328-1.277-1.682-1.277-1.682-1.044-.714.079-.699.079-.699 1.154.081 1.761 1.185 1.761 1.185 1.026 1.758 2.692 1.25 3.348.956.104-.743.402-1.251.731-1.539-2.552-.291-5.236-1.276-5.236-5.681 0-1.255.449-2.282 1.184-3.086-.119-.291-.513-1.462.112-3.048 0 0 .966-.309 3.165 1.179A10.98 10.98 0 0 1 12 6.033c.973.004 1.954.132 2.87.388 2.197-1.488 3.162-1.179 3.162-1.179.627 1.586.233 2.757.114 3.048.737.804 1.182 1.831 1.182 3.086 0 4.416-2.688 5.387-5.249 5.673.413.355.781 1.055.781 2.126 0 1.535-.014 2.772-.014 3.149 0 .309.207.668.792.555C20.211 21.394 23.5 17.082 23.5 12 23.5 5.649 18.351.5 12 .5Z" />
    </svg>
  );
}

function UserProfileMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const { authRequired, logout, user } = useAuth();
  const canAccessSettings =
    user?.role === "admin" || !!user?.permissions?.accessSettings;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
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
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        className={`app-header-link app-profile-menu__trigger${menuOpen ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="User menu"
      >
        <span className="app-profile-menu__icon" aria-hidden="true">
          <User />
        </span>
      </button>

      {menuOpen && (
        <div className="app-profile-menu__dropdown" role="menu">
          <ul className="app-profile-menu__list">
            <li role="none">
              <Link
                to="/profile"
                role="menuitem"
                className="app-profile-menu__item"
                onClick={closeMenu}
              >
                <User className="app-profile-menu__item-icon" />
                <span>Profile</span>
              </Link>
            </li>
            {canAccessSettings && (
              <li role="none">
                <Link
                  to="/settings"
                  role="menuitem"
                  className="app-profile-menu__item"
                  onClick={closeMenu}
                >
                  <Settings className="app-profile-menu__item-icon" />
                  <span>Settings</span>
                </Link>
              </li>
            )}
            <li role="none">
              <a
                href="https://github.com/sponsors/lklynet/"
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
                <GitHubIcon className="app-profile-menu__item-icon" />
                <span>GitHub</span>
                <ExternalLink className="app-profile-menu__item-external" />
              </a>
            </li>
            {authRequired && (
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
