import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink } from "./icons";
import {
  extractReleaseNoteItems,
  normalizeReleaseVersion,
  selectNightlyUpdate,
} from "../../../lib/release-version";
import TooltipButton from "./TooltipButton";
import { parseResponse } from "hono/client";
import { updatesClient } from "../utils/api/clients/updates.ts";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NIGHTLY_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MAX_NIGHTLY_NOTES = 8;

interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  notes: string[];
}

interface CachedUpdate {
  sourceVersion: string;
  update: UpdateInfo | null;
}

interface GithubCompare {
  status?: string;
  commits?: { commit?: { message?: string } }[];
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string | null;
}

interface UpdateIndicatorProps {
  currentVersion?: string | null;
  visible?: boolean;
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed with ${response.status}`);
  }
  return response.json();
}

function isSha(value: string) {
  return /^[0-9a-f]{7,40}$/i.test(value || "");
}

function readStorage(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const UpdateIndicator = ({ currentVersion, visible = true }: UpdateIndicatorProps) => {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const resolvedVersion: string = currentVersion || import.meta.env.VITE_APP_VERSION;
  const repo = import.meta.env.VITE_GITHUB_REPO || "lklynet/aurral";
  const releaseChannel = (import.meta.env.VITE_RELEASE_CHANNEL || "stable").toLowerCase();
  const isNightly = releaseChannel === "nightly";
  const checkIntervalMs = isNightly ? NIGHTLY_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS;
  const cacheKey = useMemo(
    () => `aurral:updateCache:${isNightly ? "v2:" : ""}${repo}:${releaseChannel}`,
    [isNightly, releaseChannel, repo],
  );
  const checkMetaKey = useMemo(
    () => `aurral:updateCheckMeta:${isNightly ? "v2:" : ""}${repo}:${releaseChannel}`,
    [isNightly, releaseChannel, repo],
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

    let cached: CachedUpdate | null = readStorage(cacheKey);
    setUpdateInfo(cached?.sourceVersion === resolvedVersion ? cached.update : null);

    const resolveNightlyUpdate = async () => {
      const published = await parseResponse(updatesClient.nightly.$get());
      const update = selectNightlyUpdate(resolvedVersion, published?.sha);
      if (!update) return null;

      const comparison: GithubCompare = await fetchJson(
        `https://api.github.com/repos/${repo}/compare/${update.current}...${published!.sha}`,
      );
      if (comparison?.status !== "ahead") return null;
      const notes = (Array.isArray(comparison?.commits) ? comparison.commits : [])
        .map((commit) =>
          String(commit?.commit?.message || "")
            .split(/\r?\n/, 1)[0]
            .trim(),
        )
        .filter(Boolean)
        .slice(-MAX_NIGHTLY_NOTES);

      return {
        ...update,
        channel: "nightly",
        url: `https://github.com/${repo}/compare/${update.current}...${published!.sha}`,
        notes,
      };
    };

    const resolveStableUpdate = async () => {
      const release: GithubRelease = await fetchJson(
        `https://api.github.com/repos/${repo}/releases/latest`,
      );
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
      const checkMeta: { lastCheckedAt?: number } | null = readStorage(checkMetaKey);
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
      } catch {
        if (active && isNightly) {
          setUpdateInfo(null);
          cached = { sourceVersion: resolvedVersion, update: null };
          writeStorage(cacheKey, cached);
        }
      }
    };

    checkForUpdate();
    const intervalId = setInterval(checkForUpdate, checkIntervalMs);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [
    cacheKey,
    checkIntervalMs,
    checkMetaKey,
    isNightly,
    releaseChannel,
    repo,
    resolvedVersion,
    visible,
  ]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (!indicatorRef.current?.contains(event.target as Node | null)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
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
  const notesTitle = "What's changed";

  return (
    <div ref={indicatorRef} className="app-update-indicator">
      <TooltipButton
        ref={triggerRef}
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
              <p className="app-update-indicator__empty">Release notes are available on GitHub.</p>
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
