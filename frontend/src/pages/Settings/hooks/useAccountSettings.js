import { useState, useEffect, useRef, useCallback } from "react";
import {
  getMyListeningHistory,
  getMyLidarrPreferences,
  updateMyListeningHistory,
  updateMyLidarrPreferences,
} from "../../../utils/api/endpoints/auth.js";

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
    const trimmedUsername = listenHistoryUsername.trim();
    const trimmedUrl = listenHistoryUrl.trim().replace(/\/+$/, "");
    if (listenHistoryProvider === "koito" && !trimmedUrl) {
      showError("Koito URL is required");
      return;
    }
    try {
      setSaving(true);
      const lidarrData = await Promise.all([
        updateMyListeningHistory(authUser.id, {
          listenHistoryProvider,
          listenHistoryUsername: listenHistoryProvider === "koito" ? null : trimmedUsername || null,
          listenHistoryUrl: listenHistoryProvider === "koito" ? trimmedUrl || null : null,
        }),
        updateMyLidarrPreferences({
          rootFolderPath: lidarrRootFolderPath || null,
          qualityProfileId: lidarrQualityProfileId ? Number(lidarrQualityProfileId) : null,
        }),
      ]).then(([, lidarrResponse]) => lidarrResponse);
      setSavedListenHistoryProvider(listenHistoryProvider);
      setSavedListenHistoryUsername(trimmedUsername);
      setSavedListenHistoryUrl(trimmedUrl);
      setListenHistoryUsername(trimmedUsername);
      setListenHistoryUrl(trimmedUrl);
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
      showError("Failed to save account settings");
    } finally {
      setSaving(false);
    }
  }, [
    authUser?.id,
    listenHistoryProvider,
    listenHistoryUsername,
    listenHistoryUrl,
    lidarrRootFolderPath,
    lidarrQualityProfileId,
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
