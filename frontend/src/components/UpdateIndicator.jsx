import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import {
  extractReleaseNoteItems,
  normalizeReleaseVersion,
  selectNightlyUpdate,
} from "../../../lib/release-version";
import TooltipButton from "./TooltipButton";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NIGHTLY_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MAX_NIGHTLY_NOTES = 8;

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status}`);
  }
  return response.json();
}

function isSha(value) {
  return /^[0-9a-f]{7,40}$/i.test(value || "");
}

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const UpdateIndicator = ({ currentVersion, visible = true }) => {
  const [updateInfo, setUpdateInfo] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const indicatorRef = useRef(null);
  const resolvedVersion = currentVersion || import.meta.env.VITE_APP_VERSION;
  const repo = import.meta.env.VITE_GITHUB_REPO || "lklynet/aurral";
  const releaseChannel = (import.meta.env.VITE_RELEASE_CHANNEL || "stable").toLowerCase();
  const isNightly = releaseChannel === "nightly";
  const checkIntervalMs = isNightly ? NIGHTLY_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS;
  const cacheKey = useMemo(
    () => `aurral:updateCache:${repo}:${releaseChannel}`,
    [releaseChannel, repo],
  );
  const checkMetaKey = useMemo(
    () => `aurral:updateCheckMeta:${repo}:${releaseChannel}`,
    [releaseChannel, repo],
  );

  useEffect(() => {
    if (!visible || releaseChannel === "preview") {
      setUpdateInfo(null);
      setMenuOpen(false);
      return undefined;
    }
    if (!resolvedVersion || resolvedVersion === "unknown" || !repo) {
      setUpdateInfo(null);
      setMenuOpen(false);
      return undefined;
    }

    let cached = readStorage(cacheKey);
    if (cached?.sourceVersion === resolvedVersion && cached.update) {
      setUpdateInfo(cached.update);
    }

    const resolveNightlyUpdate = async () => {
      const head = await fetchJson(`https://api.github.com/repos/${repo}/commits/main`);
      const update = selectNightlyUpdate(resolvedVersion, head?.sha);
      if (!update) return null;

      let notes = [];
      try {
        const comparison = await fetchJson(
          `https://api.github.com/repos/${repo}/compare/${update.current}...${head.sha}`,
        );
        notes = (Array.isArray(comparison?.commits) ? comparison.commits : [])
          .map((commit) => String(commit?.commit?.message || "").split(/\r?\n/, 1)[0].trim())
          .filter(Boolean)
          .slice(-MAX_NIGHTLY_NOTES);
      } catch {}

      return {
        ...update,
        channel: "nightly",
        url: `https://github.com/${repo}/compare/${update.current}...${head.sha}`,
        notes,
      };
    };

    const resolveStableUpdate = async () => {
      const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
      const latest = normalizeReleaseVersion(release?.tag_name);
      if (!latest) return null;

      const currentIsSha = isSha(resolvedVersion);
      const current = currentIsSha
        ? resolvedVersion.slice(0, 7)
        : normalizeReleaseVersion(resolvedVersion);
      if (!currentIsSha && latest === current) return null;

      return {
        current,
        latest,
        channel: "stable",
        url: release?.html_url || `https://github.com/${repo}/releases/tag/v${latest}`,
        notes: extractReleaseNoteItems(release?.body),
      };
    };

    let active = true;
    const checkForUpdate = async () => {
      const checkMeta = readStorage(checkMetaKey);
      if (
        checkMeta?.lastCheckedAt &&
        Date.now() - Number(checkMeta.lastCheckedAt) < checkIntervalMs &&
        cached?.sourceVersion === resolvedVersion
      ) {
        return;
      }

      try {
        const update = isNightly ? await resolveNightlyUpdate() : await resolveStableUpdate();
        if (!active) return;
        writeStorage(checkMetaKey, { lastCheckedAt: Date.now() });
        if (!update) {
          setUpdateInfo(null);
          setMenuOpen(false);
          cached = { sourceVersion: resolvedVersion, update: null };
          writeStorage(cacheKey, cached);
          return;
        }
        const nextUpdate = { ...update };
        setUpdateInfo(nextUpdate);
        cached = { sourceVersion: resolvedVersion, update: nextUpdate };
        writeStorage(cacheKey, cached);
      } catch {}
    };

    checkForUpdate();
    const intervalId = setInterval(checkForUpdate, checkIntervalMs);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [cacheKey, checkIntervalMs, checkMetaKey, isNightly, releaseChannel, repo, resolvedVersion, visible]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!indicatorRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  if (!updateInfo) return null;

  const updateLabel = `Update available: ${updateInfo.latest}`;
  const notesTitle = isNightly ? "What's coming" : "What's changed";

  return (
    <div ref={indicatorRef} className="app-update-indicator">
      <TooltipButton
        label={updateLabel}
        className={`app-header-link app-update-indicator__trigger is-available${menuOpen ? " is-open" : ""}`}
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
      >
        <Download aria-hidden="true" />
      </TooltipButton>

      {menuOpen && (
        <div className="app-update-indicator__popover" role="dialog" aria-label="Update preview">
          <div>
            <p className="app-update-indicator__title">Update available</p>
            <p className="app-update-indicator__version">
              {updateInfo.current} <span aria-hidden="true">→</span> {updateInfo.latest}
            </p>
          </div>

          <div className="app-update-indicator__preview">
            <p className="app-update-indicator__preview-title">{notesTitle}</p>
            {updateInfo.notes.length > 0 ? (
              <ul className="app-update-indicator__notes">
                {updateInfo.notes.map((note, index) => (
                  <li key={`${note}-${index}`}>{note}</li>
                ))}
              </ul>
            ) : (
              <p className="app-update-indicator__empty">
                Release notes are available on GitHub.
              </p>
            )}
          </div>

          <div className="app-update-indicator__actions">
            <a
              href={updateInfo.url}
              target="_blank"
              rel="noreferrer"
              className="btn btn-primary btn-sm"
            >
              View {isNightly ? "changes" : "release"}
              <ExternalLink aria-hidden="true" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
};

export default UpdateIndicator;
