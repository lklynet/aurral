import { useEffect, useMemo, useRef, useState } from "react";

const UpdateBanner = ({ currentVersion, visible = true }) => {
  const [updateInfo, setUpdateInfo] = useState(null);
  const updateNotifiedRef = useRef(null);
  const dismissedUpdateRef = useRef(null);
  const resolvedVersion = currentVersion || import.meta.env.VITE_APP_VERSION;
  const repo = import.meta.env.VITE_GITHUB_REPO || "lklynet/aurral";
  const inferredChannel = resolvedVersion?.includes("-test.")
    ? "test"
    : "stable";
  const releaseChannel =
    (
      import.meta.env.VITE_RELEASE_CHANNEL ||
      inferredChannel
    ).toLowerCase() === "test"
      ? "test"
      : "stable";
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
    const normalizeVersion = (value) => (value || "").replace(/^v/, "");
    if (!currentVersion || currentVersion === "unknown" || !repo) {
      return;
    }
    const currentIsSha = isSha(currentVersion);
    const currentLabel = normalizeVersion(currentVersion);
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
        const endpoint =
          releaseChannel === "test"
            ? `https://api.github.com/repos/${repo}/releases?per_page=10`
            : `https://api.github.com/repos/${repo}/releases/latest`;
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
        const data = Array.isArray(payload)
          ? (
              currentVersion.includes("-test.")
                ? payload.find((release) => !release?.draft && release.prerelease)
                : null
            ) ||
            payload.find((release) => !release?.draft) ||
            null
          : payload;
        if (!data) {
          return;
        }
        const latestSha = (data.target_commitish || "").trim();
        const latestLabel = normalizeVersion(data.tag_name || "");
        const releaseUrl =
          data.html_url || `https://github.com/${repo}/releases/latest`;
        const latestKey = currentIsSha ? latestSha : latestLabel;
        if (!latestKey) {
          return;
        }
        if (
          (currentIsSha && latestSha === currentVersion) ||
          (!currentIsSha && latestLabel === currentLabel)
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
          latest: currentIsSha
            ? latestLabel || formatSha(latestSha)
            : latestLabel,
          latestKey,
          url: releaseUrl,
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
  }, [checkMetaKey, dismissKey, releaseChannel, repo, resolvedVersion, visible]);

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
    <div className="mb-6 bg-[#211f27] px-5 py-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <p className="text-sm uppercase tracking-wide">
            Update available: <span className="text-[#c1c1c3]">{updateInfo.current}</span> → <span className="text-[#90a47a]">{updateInfo.latest}</span>
          </p>
          <p className="text-xs text-[#c1c1c3]">
            A newer build is ready. Update when convenient.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <a
            href={updateInfo.url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary bg-gray-700/50 hover:bg-gray-700/70 btn-sm w-full sm:w-auto"
          >
            View release
          </a>
          <button
            type="button"
            className="btn btn-ghost btn-sm hover:bg-gray-700/50 w-full sm:w-auto"
            onClick={dismissUpdate}
          >
            Hide until next update
          </button>
        </div>
      </div>
    </div>
  );
};

export default UpdateBanner;
