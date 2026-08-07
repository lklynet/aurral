import { useState, useEffect, useRef, useCallback } from "react";
import {
  getMyListeningHistory,
  getMyLidarrPreferences,
  updateMyListeningHistory,
  updateMyLidarrPreferences,
} from "../../../utils/api/endpoints/auth.js";

function areDraftsEqual(left, right) {
  return (
    left?.provider === right?.provider &&
    left?.username === right?.username &&
    left?.url === right?.url &&
    left?.rootFolderPath === right?.rootFolderPath &&
    left?.qualityProfileId === right?.qualityProfileId
  );
}

export function useAccountSettings(authUser, showError) {
  const [listenHistoryProvider, setListenHistoryProvider] = useState("lastfm");
  const [listenHistoryUsername, setListenHistoryUsername] = useState("");
  const [listenHistoryUrl, setListenHistoryUrl] = useState("");
  const [savedListenHistoryProvider, setSavedListenHistoryProvider] = useState("lastfm");
  const [savedListenHistoryUsername, setSavedListenHistoryUsername] = useState("");
  const [savedListenHistoryUrl, setSavedListenHistoryUrl] = useState("");
  const [lidarrConfigured, setLidarrConfigured] = useState(false);
  const [lidarrRootFolders, setLidarrRootFolders] = useState([]);
  const [lidarrQualityProfiles, setLidarrQualityProfiles] = useState([]);
  const [lidarrRootFolderPath, setLidarrRootFolderPath] = useState("");
  const [savedLidarrRootFolderPath, setSavedLidarrRootFolderPath] = useState("");
  const [lidarrQualityProfileId, setLidarrQualityProfileId] = useState("");
  const [savedLidarrQualityProfileId, setSavedLidarrQualityProfileId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef(null);
  const handleSaveRef = useRef(null);
  const saveInFlightRef = useRef(null);
  const saveQueuedRef = useRef(false);
  const currentDraftRef = useRef(null);
  const hasUnsavedChangesRef = useRef(false);
  const isListenHistoryValidRef = useRef(false);

  const hasUnsavedChanges =
    listenHistoryProvider !== savedListenHistoryProvider ||
    listenHistoryUsername !== savedListenHistoryUsername ||
    listenHistoryUrl !== savedListenHistoryUrl ||
    lidarrRootFolderPath !== savedLidarrRootFolderPath ||
    lidarrQualityProfileId !== savedLidarrQualityProfileId;

  const isListenHistoryValid =
    listenHistoryProvider !== "koito" || !!listenHistoryUrl.trim().replace(/\/+$/, "");

  hasUnsavedChangesRef.current = hasUnsavedChanges;
  isListenHistoryValidRef.current = isListenHistoryValid;
  const currentDraft = {
    provider: listenHistoryProvider,
    username: listenHistoryUsername.trim(),
    url: listenHistoryUrl.trim().replace(/\/+$/, ""),
    rootFolderPath: lidarrRootFolderPath,
    qualityProfileId: lidarrQualityProfileId,
  };
  currentDraftRef.current = currentDraft;

  const fetchListeningHistory = useCallback(async () => {
    try {
      setLoading(true);
      const [historyData, lidarrData] = await Promise.all([
        getMyListeningHistory(),
        getMyLidarrPreferences(),
      ]);
      const provider = historyData.listenHistoryProvider || "lastfm";
      const username = historyData.listenHistoryUsername || "";
      const url = historyData.listenHistoryUrl || "";
      setListenHistoryProvider(provider);
      setListenHistoryUsername(username);
      setListenHistoryUrl(url);
      setSavedListenHistoryProvider(provider);
      setSavedListenHistoryUsername(username);
      setSavedListenHistoryUrl(url);
      setLidarrConfigured(lidarrData?.configured === true);
      setLidarrRootFolders(Array.isArray(lidarrData?.rootFolders) ? lidarrData.rootFolders : []);
      setLidarrQualityProfiles(
        Array.isArray(lidarrData?.qualityProfiles) ? lidarrData.qualityProfiles : [],
      );
      const nextRootFolderPath = lidarrData?.savedDefaults?.rootFolderPath || "";
      const nextQualityProfileId =
        lidarrData?.savedDefaults?.qualityProfileId != null
          ? String(lidarrData.savedDefaults.qualityProfileId)
          : "";
      setLidarrRootFolderPath(nextRootFolderPath);
      setSavedLidarrRootFolderPath(nextRootFolderPath);
      setLidarrQualityProfileId(nextQualityProfileId);
      setSavedLidarrQualityProfileId(nextQualityProfileId);
    } catch {
      showError("Failed to load account settings");
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    fetchListeningHistory();
  }, [fetchListeningHistory]);

  const handleSave = useCallback(async () => {
    if (!authUser?.id) return;
    if (saveInFlightRef.current) {
      saveQueuedRef.current = true;
      return saveInFlightRef.current;
    }

    const saveDraft = currentDraftRef.current;
    if (saveDraft.provider === "koito" && !saveDraft.url) {
      showError("Koito URL is required");
      return;
    }
    let succeeded = false;
    const request = (async () => {
      try {
        setSaving(true);
        const lidarrData = await Promise.all([
          updateMyListeningHistory(authUser.id, {
            listenHistoryProvider: saveDraft.provider,
            listenHistoryUsername:
              saveDraft.provider === "koito" ? null : saveDraft.username || null,
            listenHistoryUrl: saveDraft.provider === "koito" ? saveDraft.url || null : null,
          }),
          updateMyLidarrPreferences({
            rootFolderPath: saveDraft.rootFolderPath || null,
            qualityProfileId: saveDraft.qualityProfileId ? Number(saveDraft.qualityProfileId) : null,
          }),
        ]).then(([, lidarrResponse]) => lidarrResponse);
        const isCurrentDraft = areDraftsEqual(currentDraftRef.current, saveDraft);

        setSavedListenHistoryProvider(saveDraft.provider);
        setSavedListenHistoryUsername(saveDraft.username);
        setSavedListenHistoryUrl(saveDraft.url);
        if (isCurrentDraft) {
          setListenHistoryUsername(saveDraft.username);
          setListenHistoryUrl(saveDraft.url);
        }
        setLidarrConfigured(lidarrData?.configured === true);
        setLidarrRootFolders(Array.isArray(lidarrData?.rootFolders) ? lidarrData.rootFolders : []);
        setLidarrQualityProfiles(
          Array.isArray(lidarrData?.qualityProfiles) ? lidarrData.qualityProfiles : [],
        );
        const nextRootFolderPath = lidarrData?.savedDefaults?.rootFolderPath || "";
        const nextQualityProfileId =
          lidarrData?.savedDefaults?.qualityProfileId != null
            ? String(lidarrData.savedDefaults.qualityProfileId)
            : "";
        if (isCurrentDraft) {
          setLidarrRootFolderPath(nextRootFolderPath);
          setLidarrQualityProfileId(nextQualityProfileId);
        }
        setSavedLidarrRootFolderPath(nextRootFolderPath);
        setSavedLidarrQualityProfileId(nextQualityProfileId);
        succeeded = true;
        return true;
      } catch {
        showError("Failed to save account settings");
        return false;
      }
    })();

    saveInFlightRef.current = request;
    try {
      return await request;
    } finally {
      saveInFlightRef.current = null;
      setSaving(false);
      if (
        (succeeded || saveQueuedRef.current) &&
        !areDraftsEqual(currentDraftRef.current, saveDraft) &&
        isListenHistoryValidRef.current
      ) {
        saveQueuedRef.current = false;
        void handleSaveRef.current?.();
      } else {
        saveQueuedRef.current = false;
      }
    }
  }, [
    authUser?.id,
    showError,
  ]);

  handleSaveRef.current = handleSave;

  useEffect(() => {
    if (loading || !hasUnsavedChanges || !isListenHistoryValid) return undefined;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void handleSaveRef.current?.();
    }, 450);
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    loading,
    hasUnsavedChanges,
    isListenHistoryValid,
    listenHistoryProvider,
    listenHistoryUsername,
    listenHistoryUrl,
    lidarrRootFolderPath,
    lidarrQualityProfileId,
  ]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (hasUnsavedChangesRef.current && isListenHistoryValidRef.current) {
        void handleSaveRef.current?.();
      }
    };
  }, []);

  return {
    listenHistoryProvider,
    setListenHistoryProvider,
    listenHistoryUsername,
    setListenHistoryUsername,
    listenHistoryUrl,
    setListenHistoryUrl,
    lidarrConfigured,
    lidarrRootFolders,
    lidarrQualityProfiles,
    lidarrRootFolderPath,
    setLidarrRootFolderPath,
    lidarrQualityProfileId,
    setLidarrQualityProfileId,
    loading,
    saving,
    handleSave,
  };
}
