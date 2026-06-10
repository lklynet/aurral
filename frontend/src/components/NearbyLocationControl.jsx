import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { ChevronDown, Locate } from "lucide-react";

function getNearbyCityLabel(location) {
  if (!location) return "Location";
  if (location.city) return location.city;
  const first = location.label?.split(",")?.[0]?.trim();
  if (first) return first;
  if (location.postalCode) return location.postalCode;
  return "Location";
}

function NearbyLocationControl({
  locationMode,
  appliedZip,
  location,
  onSelectYourLocation,
  onStartCustomLocation,
  onApplyZip,
  className = "",
}) {
  const wrapRef = useRef(null);
  const zipInputRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [zipDraft, setZipDraft] = useState(appliedZip);
  const [showZipForm, setShowZipForm] = useState(false);
  const zipModeActive = locationMode === "zip";
  const cityLabel = getNearbyCityLabel(location);
  const zipFormVisible =
    showZipForm || (zipModeActive && menuOpen && !appliedZip.trim());

  useEffect(() => {
    setZipDraft(appliedZip);
  }, [appliedZip]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handleClickOutside = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setMenuOpen(false);
        setShowZipForm(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setShowZipForm(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen || !zipFormVisible) return;
    zipInputRef.current?.focus();
  }, [menuOpen, zipFormVisible]);

  const closeMenu = () => {
    setMenuOpen(false);
    setShowZipForm(false);
  };

  const handleYourLocation = () => {
    onSelectYourLocation();
    closeMenu();
  };

  const handleEnterLocation = () => {
    onStartCustomLocation();
    setShowZipForm(true);
    setZipDraft(appliedZip);
  };

  const saveZip = () => {
    const sanitized = zipDraft.trim();
    if (!sanitized) return;
    onApplyZip(sanitized);
    closeMenu();
  };

  return (
    <div ref={wrapRef} className={`artist-nearby-location ${className}`.trim()}>
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        className={`artist-nearby-badge${menuOpen ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Location: ${cityLabel}`}
      >
        <span>{cityLabel}</span>
        <ChevronDown
          className={`artist-icon-xs artist-nearby-badge__chevron${menuOpen ? " artist-chevron--open" : ""}`}
          aria-hidden="true"
        />
      </button>
      {menuOpen && (
        <>
          <button
            type="button"
            className="artist-backdrop-button"
            onClick={closeMenu}
            aria-label="Close location menu"
          />
          <div
            className="artist-dropdown artist-dropdown--right artist-nearby-location__menu"
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              onClick={handleYourLocation}
              className={`artist-menu-item${!zipModeActive ? " is-active" : ""}`}
            >
              <span className="artist-menu-item__label">
                <Locate className="artist-icon-sm" aria-hidden="true" />
                Your location
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={handleEnterLocation}
              className={`artist-menu-item${zipModeActive ? " is-active" : ""}`}
            >
              Enter a location
            </button>
            {zipFormVisible && (
              <div className="artist-nearby-zip-editor artist-nearby-zip-editor--menu">
                <div className="artist-nearby-zip-editor__field">
                  <input
                    ref={zipInputRef}
                    type="text"
                    value={zipDraft}
                    onChange={(event) => setZipDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      saveZip();
                    }}
                    className="artist-nearby-zip-editor__input"
                    placeholder="ZIP or postal code"
                  />
                </div>
                <div className="artist-nearby-zip-editor__actions">
                  <button
                    type="button"
                    onClick={closeMenu}
                    className="btn btn-secondary btn-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveZip}
                    className="btn btn-primary btn-sm"
                    disabled={!zipDraft.trim()}
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

NearbyLocationControl.propTypes = {
  locationMode: PropTypes.oneOf(["ip", "zip"]).isRequired,
  appliedZip: PropTypes.string.isRequired,
  location: PropTypes.shape({
    city: PropTypes.string,
    label: PropTypes.string,
    postalCode: PropTypes.string,
  }),
  onSelectYourLocation: PropTypes.func.isRequired,
  onStartCustomLocation: PropTypes.func.isRequired,
  onApplyZip: PropTypes.func.isRequired,
  className: PropTypes.string,
};

export default NearbyLocationControl;
