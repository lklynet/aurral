import { useState, useEffect, useCallback } from "react";
import {
  getMyListeningHistory,
  getMyLidarrPreferences,
  updateMyListeningHistory,
  updateMyLidarrPreferences,
} from "../../../utils/api";

export function useAccountSettings(authUser, showSuccess, showError) {
  const [listenHistoryProvider, setListenHistoryProvider] = useState("lastfm");
  const [listenHistoryUsername, setListenHistoryUsername] = useState("");
  const [savedListenHistoryProvider, setSavedListenHistoryProvider] =
    useState("lastfm");
  const [savedListenHistoryUsername, setSavedListenHistoryUsername] =
    useState("");
  const [lidarrConfigured, setLidarrConfigured] = useState(false);
  const [lidarrRootFolders, setLidarrRootFolders] = useState([]);
  const [lidarrQualityProfiles, setLidarrQualityProfiles] = useState([]);
  const [lidarrRootFolderPath, setLidarrRootFolderPath] = useState("");
  const [savedLidarrRootFolderPath, setSavedLidarrRootFolderPath] =
    useState("");
  const [lidarrQualityProfileId, setLidarrQualityProfileId] = useState("");
  const [savedLidarrQualityProfileId, setSavedLidarrQualityProfileId] =
    useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const hasUnsavedChanges =
    listenHistoryProvider !== savedListenHistoryProvider ||
    listenHistoryUsername !== savedListenHistoryUsername ||
    lidarrRootFolderPath !== savedLidarrRootFolderPath ||
    lidarrQualityProfileId !== savedLidarrQualityProfileId;

  const fetchListeningHistory = useCallback(async () => {
    try {
      setLoading(true);
      const [historyData, lidarrData] = await Promise.all([
        getMyListeningHistory(),
        getMyLidarrPreferences(),
      ]);
      const provider = historyData.listenHistoryProvider || "lastfm";
      const username = historyData.listenHistoryUsername || "";
      setListenHistoryProvider(provider);
      setListenHistoryUsername(username);
      setSavedListenHistoryProvider(provider);
      setSavedListenHistoryUsername(username);
      setLidarrConfigured(lidarrData?.configured === true);
      setLidarrRootFolders(
        Array.isArray(lidarrData?.rootFolders) ? lidarrData.rootFolders : [],
      );
      setLidarrQualityProfiles(
        Array.isArray(lidarrData?.qualityProfiles)
          ? lidarrData.qualityProfiles
          : [],
      );
      const nextRootFolderPath =
        lidarrData?.savedDefaults?.rootFolderPath || "";
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
    try {
      setSaving(true);
      const trimmedUsername = listenHistoryUsername.trim();
      const lidarrData = await Promise.all([
        updateMyListeningHistory(
          authUser.id,
          listenHistoryProvider,
          trimmedUsername || null,
        ),
        updateMyLidarrPreferences({
          rootFolderPath: lidarrRootFolderPath || null,
          qualityProfileId: lidarrQualityProfileId
            ? Number(lidarrQualityProfileId)
            : null,
        }),
      ]).then(([, lidarrResponse]) => lidarrResponse);
      setSavedListenHistoryProvider(listenHistoryProvider);
      setSavedListenHistoryUsername(trimmedUsername);
      setListenHistoryUsername(trimmedUsername);
      setLidarrConfigured(lidarrData?.configured === true);
      setLidarrRootFolders(
        Array.isArray(lidarrData?.rootFolders) ? lidarrData.rootFolders : [],
      );
      setLidarrQualityProfiles(
        Array.isArray(lidarrData?.qualityProfiles)
          ? lidarrData.qualityProfiles
          : [],
      );
      const nextRootFolderPath =
        lidarrData?.savedDefaults?.rootFolderPath || "";
      const nextQualityProfileId =
        lidarrData?.savedDefaults?.qualityProfileId != null
          ? String(lidarrData.savedDefaults.qualityProfileId)
          : "";
      setLidarrRootFolderPath(nextRootFolderPath);
      setSavedLidarrRootFolderPath(nextRootFolderPath);
      setLidarrQualityProfileId(nextQualityProfileId);
      setSavedLidarrQualityProfileId(nextQualityProfileId);
      showSuccess("Profile saved");
    } catch {
      showError("Failed to save account settings");
    } finally {
      setSaving(false);
    }
  }, [
    authUser?.id,
    listenHistoryProvider,
    listenHistoryUsername,
    lidarrRootFolderPath,
    lidarrQualityProfileId,
    showSuccess,
    showError,
  ]);

  return {
    listenHistoryProvider,
    setListenHistoryProvider,
    listenHistoryUsername,
    setListenHistoryUsername,
    lidarrConfigured,
    lidarrRootFolders,
    lidarrQualityProfiles,
    lidarrRootFolderPath,
    setLidarrRootFolderPath,
    lidarrQualityProfileId,
    setLidarrQualityProfileId,
    hasUnsavedChanges,
    loading,
    saving,
    handleSave,
  };
}
