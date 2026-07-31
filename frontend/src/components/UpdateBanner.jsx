import { useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeReleaseVersion,
  selectLatestRelease,
  selectNightlyUpdate,
} from "../../../lib/release-version";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const UpdateBanner = ({ currentVersion, visible = true }) => {
  const [updateInfo, setUpdateInfo] = useState(null);
  const updateNotifiedRef = useRef(null);
  const dismissedUpdateRef = useRef(null);
  const resolvedVersion = currentVersion || import.meta.env.VITE_APP_VERSION;
  const repo = import.meta.env.VITE_GITHUB_REPO || "lklynet/aurral";
  const releaseChannel = (import.meta.env.VITE_RELEASE_CHANNEL || "stable").toLowerCase();
  const isNightly = releaseChannel === "nightly";
  const dismissKey = useMemo(
    () => `aurral:updateDismissed:${repo}:${releaseChannel}`,
    [releaseChannel, repo],
  );
  const checkMetaKey = useMemo(
    () => `aurral:updateCheckMeta:${repo}:${releaseChannel}`,
    [releaseChannel, repo],
  );

  useEffect(() => {
    if (!visible) {
      setUpdateInfo(null);
      return;
    }
    if (releaseChannel === "preview") {
      return;
    }
    if (!resolvedVersion || resolvedVersion === "unknown" || !repo) {
      return;
    }

    const isSha = (value) => /^[0-9a-f]{7,40}$/i.test(value || "");
    const currentIsSha = isSha(resolvedVersion);
    const currentLabel = normalizeReleaseVersion(resolvedVersion);

    const resolveNightlyUpdate = async () => {
      const res = await fetch(`https://api.github.com/repos/${repo}/commits/main`);
      if (!res.ok) {
        return null;
      }
      const update = selectNightlyUpdate(resolvedVersion, (await res.json())?.sha);
      return update && { ...update, url: `https://github.com/${repo}/commits/main` };
    };

    const resolveStableUpdate = async () => {
      const res = await fetch(`https://api.github.com/repos/${repo}/git/matching-refs/tags/v`);
      if (!res.ok) {
        return null;
      }
      const payload = await res.json();
      const latestRelease = selectLatestRelease(Array.isArray(payload) ? payload : []);
      if (!latestRelease) {
        return null;
      }
      const latestLabel = latestRelease.parsed.label;
      if (!currentIsSha && latestLabel === currentLabel) {
        return null;
      }
      return {
        current: currentIsSha ? resolvedVersion.slice(0, 7) : currentLabel,
        latest: latestLabel,
        url: `https://github.com/${repo}/releases/tag/${latestRelease.tagName}`,
      };
    };

    let active = true;
    const checkForUpdate = async () => {
      try {
        let checkMeta = null;
        try {
          checkMeta = JSON.parse(localStorage.getItem(checkMetaKey) || "null");
        } catch {}
        if (
          checkMeta?.lastCheckedAt &&
          Date.now() - Number(checkMeta.lastCheckedAt) < CHECK_INTERVAL_MS
        ) {
          return;
        }
        const update = isNightly ? await resolveNightlyUpdate() : await resolveStableUpdate();
        localStorage.setItem(checkMetaKey, JSON.stringify({ lastCheckedAt: Date.now() }));
        if (!update) {
          return;
        }
        const latestKey = update.latest;
        const dismissedVersion = dismissedUpdateRef.current ?? localStorage.getItem(dismissKey);
        if (dismissedVersion === latestKey || updateNotifiedRef.current === latestKey || !active) {
          return;
        }
        setUpdateInfo({ ...update, latestKey });
        updateNotifiedRef.current = latestKey;
      } catch {}
    };
    checkForUpdate();
    const intervalId = setInterval(checkForUpdate, CHECK_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [checkMetaKey, dismissKey, isNightly, releaseChannel, repo, resolvedVersion, visible]);

  const dismissUpdate = () => {
    if (!updateInfo?.latestKey) {
      return;
    }
    dismissedUpdateRef.current = updateInfo.latestKey;
    localStorage.setItem(dismissKey, updateInfo.latestKey);
    setUpdateInfo(null);
  };

  if (!updateInfo) {
    return null;
  }

  return (
    <div className="app-banner">
      <div className="app-banner__content">
        <p className="app-banner__title">Update available</p>
        <p className="app-banner__text">
          <span className="app-banner__meta">{updateInfo.current}</span>
          {" → "}
          <span className="app-banner__highlight">{updateInfo.latest}</span>
          {". "}
          {isNightly
            ? "A newer nightly build is ready. Update when convenient."
            : "A newer stable build is ready. Update when convenient."}
        </p>
      </div>
      <div className="app-banner__actions">
        <a
          href={updateInfo.url}
          target="_blank"
          rel="noreferrer"
          className="btn btn-secondary btn-sm"
        >
          {isNightly ? "View changes" : "View release"}
        </a>
        <button type="button" className="btn btn-ghost btn-sm" onClick={dismissUpdate}>
          Hide until next update
        </button>
      </div>
    </div>
  );
};

export default UpdateBanner;
