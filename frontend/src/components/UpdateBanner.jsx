import { useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeReleaseVersion,
  selectLatestReleaseForChannel,
} from "../utils/releaseVersion";

const UpdateBanner = ({ currentVersion, visible = true }) => {
  const [updateInfo, setUpdateInfo] = useState(null);
  const updateNotifiedRef = useRef(null);
  const dismissedUpdateRef = useRef(null);
  const resolvedVersion = currentVersion || import.meta.env.VITE_APP_VERSION;
  const repo = import.meta.env.VITE_GITHUB_REPO || "lklynet/aurral";
  const inferredChannel = resolvedVersion?.includes("-test.")
    ? "test"
    : resolvedVersion?.includes("-dev.")
      ? "dev"
      : "stable";
  const releaseChannel = (() => {
    const channel = (
      import.meta.env.VITE_RELEASE_CHANNEL || inferredChannel
    ).toLowerCase();
    if (channel === "test" || channel === "dev") {
      return channel;
    }
    return "stable";
  })();
  const isPrereleaseChannel =
    releaseChannel === "test" || releaseChannel === "dev";
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
    const currentVersion = resolvedVersion;
    const formatSha = (value) => (value ? value.slice(0, 7) : "");
    const isSha = (value) => /^[0-9a-f]{7,40}$/i.test(value || "");
    if (!currentVersion || currentVersion === "unknown" || !repo) {
      return;
    }
    const currentIsSha = isSha(currentVersion);
    const currentLabel = normalizeReleaseVersion(currentVersion);
    const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
    let active = true;
    const checkForUpdate = async () => {
      try {
        const now = Date.now();
        let checkMeta = null;
        try {
          checkMeta = JSON.parse(localStorage.getItem(checkMetaKey) || "null");
        } catch {}
        if (
          checkMeta?.lastCheckedAt &&
          now - Number(checkMeta.lastCheckedAt) < CHECK_INTERVAL_MS
        ) {
          return;
        }
        const endpoint = `https://api.github.com/repos/${repo}/git/matching-refs/tags/v`;
        const res = await fetch(endpoint);
        if (!res.ok) {
          localStorage.setItem(
            checkMetaKey,
            JSON.stringify({ lastCheckedAt: Date.now() }),
          );
          return;
        }
        const payload = await res.json();
        localStorage.setItem(
          checkMetaKey,
          JSON.stringify({ lastCheckedAt: Date.now() }),
        );
        const latestRelease = selectLatestReleaseForChannel(
          Array.isArray(payload) ? payload : [],
          releaseChannel,
        );
        if (!latestRelease) {
          return;
        }
        const latestLabel = latestRelease.parsed.label;
        const releaseUrl = isPrereleaseChannel
          ? `https://github.com/${repo}/tags`
          : `https://github.com/${repo}/releases/tag/${latestRelease.tagName}`;
        const latestKey = latestLabel;
        if (!latestKey) {
          return;
        }
        if (
          (!currentIsSha && latestLabel === currentLabel) ||
          (currentIsSha &&
            updateNotifiedRef.current === latestKey &&
            currentLabel === latestLabel)
        ) {
          return;
        }
        const dismissedVersion =
          dismissedUpdateRef.current ??
          localStorage.getItem(dismissKey);
        if (dismissedVersion === latestKey) {
          return;
        }
        if (updateNotifiedRef.current === latestKey) {
          return;
        }
        if (!active) {
          return;
        }
        setUpdateInfo({
          current: currentIsSha ? formatSha(currentVersion) : currentLabel,
          latest: latestLabel,
          latestKey,
          url: releaseUrl,
          channel: releaseChannel,
        });
        updateNotifiedRef.current = latestKey;
      } catch {}
    };
    checkForUpdate();
    const intervalId = setInterval(checkForUpdate, CHECK_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [
    checkMetaKey,
    dismissKey,
    isPrereleaseChannel,
    releaseChannel,
    repo,
    resolvedVersion,
    visible,
  ]);

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
          {isPrereleaseChannel
            ? `A newer ${updateInfo.channel} build is ready. Update when convenient.`
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
          {isPrereleaseChannel ? "View tags" : "View release"}
        </a>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={dismissUpdate}
        >
          Hide until next update
        </button>
      </div>
    </div>
  );
};

export default UpdateBanner;
