import { useState, useEffect, useRef } from "react";
import { ChevronDown, Locate } from "lucide-react";

const NEARBY_COUNTRIES = [
  ["", "Country"],
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
  ["IE", "Ireland"],
  ["AU", "Australia"],
  ["NZ", "New Zealand"],
  ["DE", "Germany"],
  ["AT", "Austria"],
  ["CH", "Switzerland"],
  ["FR", "France"],
  ["BE", "Belgium"],
  ["NL", "Netherlands"],
  ["DK", "Denmark"],
  ["SE", "Sweden"],
  ["NO", "Norway"],
  ["FI", "Finland"],
  ["PL", "Poland"],
  ["CZ", "Czechia"],
  ["ES", "Spain"],
  ["IT", "Italy"],
  ["MX", "Mexico"],
  ["BR", "Brazil"],
  ["JP", "Japan"],
];

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
  appliedCountry = "",
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
  const [countryDraft, setCountryDraft] = useState(appliedCountry);
  const [showZipForm, setShowZipForm] = useState(false);
  const zipModeActive = locationMode === "zip";
  const cityLabel = getNearbyCityLabel(location);
  const zipFormVisible = showZipForm || (zipModeActive && menuOpen && !appliedZip.trim());

  useEffect(() => {
    setZipDraft(appliedZip);
    setCountryDraft(appliedCountry);
  }, [appliedZip, appliedCountry]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "mousedown" && wrapRef.current?.contains(event.target)) {
        return;
      }
      setMenuOpen(false);
      setShowZipForm(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
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

  const saveZip = () => {
    const sanitized = zipDraft.trim();
    if (!sanitized) return;
    onApplyZip(sanitized, countryDraft);
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
        <div
          className="artist-dropdown artist-dropdown--right artist-nearby-location__menu"
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onSelectYourLocation();
              closeMenu();
            }}
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
            onClick={() => {
              onStartCustomLocation();
              setShowZipForm(true);
              setZipDraft(appliedZip);
              setCountryDraft(appliedCountry);
            }}
            className={`artist-menu-item${zipModeActive ? " is-active" : ""}`}
          >
            Enter a location
          </button>
          {zipFormVisible && (
            <div className="artist-nearby-zip-editor artist-nearby-zip-editor--menu">
              <div className="artist-nearby-zip-editor__field">
                <label htmlFor="nearby-location-zip">ZIP or postal code</label>
                <input
                  ref={zipInputRef}
                  id="nearby-location-zip"
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
              <div className="artist-nearby-zip-editor__field">
                <label htmlFor="nearby-location-country">Country</label>
                <select
                  id="nearby-location-country"
                  value={countryDraft}
                  onChange={(event) => setCountryDraft(event.target.value)}
                  className="artist-nearby-zip-editor__input"
                >
                  {NEARBY_COUNTRIES.map(([code, name]) => (
                    <option key={code || "any"} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="artist-nearby-zip-editor__actions">
                <button type="button" onClick={closeMenu} className="btn btn-secondary btn-sm">
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
      )}
    </div>
  );
}

export default NearbyLocationControl;
