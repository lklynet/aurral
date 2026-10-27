import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse, type InferRequestType } from "hono/client";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { queryClient, queryKeys } from "../../../queryClient.ts";
import type { useAuth } from "../../../contexts/AuthContext";
import type { lidarrClient } from "../../../../../backend/services/lidarrClient.ts";

type AuthUser = NonNullable<ReturnType<typeof useAuth>>["user"];
type LidarrPreferences = Awaited<ReturnType<typeof lidarrClient.getArtistAddPreferenceSummary>>;
type LidarrRootFolder = LidarrPreferences["rootFolders"][number];
type LidarrQualityProfile = LidarrPreferences["qualityProfiles"][number];
type AccountDraft = {
  provider: string;
  username: string;
  url: string;
  rootFolderPath: string;
  qualityProfileId: string;
};
type LidarrPreferencesUpdate = InferRequestType<
  (typeof usersClient.me)["lidarr-preferences"]["$patch"]
>["json"];
type ListenHistoryPayload = {
  listenHistoryProvider: string;
  listenHistoryUsername: string | null;
  listenHistoryUrl: string | null;
};

function areDraftsEqual(left: AccountDraft | null, right: AccountDraft | null) {
  return (
    left?.provider === right?.provider &&
    left?.username === right?.username &&
    left?.url === right?.url &&
    left?.rootFolderPath === right?.rootFolderPath &&
    left?.qualityProfileId === right?.qualityProfileId
  );
}

const isCurrentAccount = (activeAccountId: number | null, savedAccountId: number) =>
  activeAccountId != null && activeAccountId === savedAccountId;

export function useAccountSettings(authUser: AuthUser, showError: (message: string) => void) {
  const [listenHistoryProvider, setListenHistoryProvider] = useState("lastfm");
  const [listenHistoryUsername, setListenHistoryUsername] = useState("");
  const [listenHistoryUrl, setListenHistoryUrl] = useState("");
  const [savedListenHistoryProvider, setSavedListenHistoryProvider] = useState("lastfm");
  const [savedListenHistoryUsername, setSavedListenHistoryUsername] = useState("");
  const [savedListenHistoryUrl, setSavedListenHistoryUrl] = useState("");
  const [lidarrConfigured, setLidarrConfigured] = useState(false);
  const [lidarrRootFolders, setLidarrRootFolders] = useState<LidarrRootFolder[]>([]);
  const [lidarrQualityProfiles, setLidarrQualityProfiles] = useState<LidarrQualityProfile[]>([]);
  const [lidarrRootFolderPath, setLidarrRootFolderPath] = useState("");
  const [savedLidarrRootFolderPath, setSavedLidarrRootFolderPath] = useState("");
  const [lidarrQualityProfileId, setLidarrQualityProfileId] = useState("");
  const [savedLidarrQualityProfileId, setSavedLidarrQualityProfileId] = useState("");
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSaveRef = useRef<(() => Promise<boolean | undefined>) | null>(null);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const saveQueuedRef = useRef(false);
  const currentDraftRef = useRef<AccountDraft | null>(null);
  const hasUnsavedChangesRef = useRef(false);
  const isListenHistoryValidRef = useRef(false);
  const activeAccountIdRef = useRef<number | null>(null);
  const saveInFlightAccountIdRef = useRef<number | null>(null);
  const hydratedHistoryAccountRef = useRef<number | null>(null);
  const hydratedLidarrAccountRef = useRef<number | null>(null);

  const hasUnsavedChanges =
    listenHistoryProvider !== savedListenHistoryProvider ||
    listenHistoryUsername !== savedListenHistoryUsername ||
    listenHistoryUrl !== savedListenHistoryUrl ||
    lidarrRootFolderPath !== savedLidarrRootFolderPath ||
    lidarrQualityProfileId !== savedLidarrQualityProfileId;

  const isListenHistoryValid =
    listenHistoryProvider !== "koito" || !!listenHistoryUrl.trim().replace(/\/+$/, "");

  const historyQueryKey = queryKeys.listeningHistory(authUser?.id);
  const lidarrQueryKey = queryKeys.lidarrPreferences(authUser?.id);
  const historyQuery = useQuery({
    queryKey: historyQueryKey,
    queryFn: ({ signal }) =>
      parseResponse(usersClient.me["listening-history"].$get({}, { init: { signal } })),
    enabled: authUser?.id != null,
    staleTime: 30_000,
  });
  const lidarrQuery = useQuery({
    queryKey: lidarrQueryKey,
    queryFn: ({ signal }) =>
      parseResponse(usersClient.me["lidarr-preferences"].$get({}, { init: { signal } })),
    enabled: authUser?.id != null,
    staleTime: 30_000,
  });
  const loading = historyQuery.isPending || lidarrQuery.isPending;
  const { mutateAsync: saveHistory } = useMutation({
    mutationFn: (json: ListenHistoryPayload) =>
      parseResponse(
        usersClient[":id"].$patch({
          param: { id: String(authUser?.id) },
          json,
        }),
      ),
    onSuccess: (data) => queryClient.setQueryData(historyQueryKey, data),
  });
  const { mutateAsync: saveLidarr } = useMutation({
    mutationFn: (json: LidarrPreferencesUpdate) =>
      parseResponse(usersClient.me["lidarr-preferences"].$patch({ json })),
    onSuccess: (data) => queryClient.setQueryData(lidarrQueryKey, data),
  });

  hasUnsavedChangesRef.current = hasUnsavedChanges;
  isListenHistoryValidRef.current = isListenHistoryValid;
  activeAccountIdRef.current = authUser?.id ?? null;
  const currentDraft = {
    provider: listenHistoryProvider,
    username: listenHistoryUsername.trim(),
    url: listenHistoryUrl.trim().replace(/\/+$/, ""),
    rootFolderPath: lidarrRootFolderPath,
    qualityProfileId: lidarrQualityProfileId,
  };
  currentDraftRef.current = currentDraft;

  useEffect(() => {
    const historyData = historyQuery.data;
    if (!historyData || authUser?.id == null) return;
    const accountChanged = hydratedHistoryAccountRef.current !== authUser.id;
    if (!accountChanged && (hasUnsavedChangesRef.current || saveInFlightRef.current)) return;
    hydratedHistoryAccountRef.current = authUser.id;
    const provider = historyData.listenHistoryProvider || "lastfm";
    const username = historyData.listenHistoryUsername || "";
    const url = historyData.listenHistoryUrl || "";
    setListenHistoryProvider(provider);
    setListenHistoryUsername(username);
    setListenHistoryUrl(url);
    setSavedListenHistoryProvider(provider);
    setSavedListenHistoryUsername(username);
    setSavedListenHistoryUrl(url);
  }, [authUser?.id, historyQuery.data]);

  useEffect(() => {
    const lidarrData = lidarrQuery.data;
    if (!lidarrData || authUser?.id == null) return;
    const accountChanged = hydratedLidarrAccountRef.current !== authUser.id;
    if (!accountChanged && (hasUnsavedChangesRef.current || saveInFlightRef.current)) return;
    hydratedLidarrAccountRef.current = authUser.id;
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
  }, [authUser?.id, lidarrQuery.data]);

  useEffect(() => {
    saveQueuedRef.current = false;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaving(false);
  }, [authUser?.id]);

  useEffect(() => {
    if (historyQuery.error || lidarrQuery.error) {
      showError("Failed to load account settings");
    }
  }, [historyQuery.error, lidarrQuery.error, showError]);

  const handleSave = useCallback(async () => {
    if (!authUser?.id) return;
    const saveAccountId = authUser.id;
    if (saveInFlightRef.current && saveInFlightAccountIdRef.current === saveAccountId) {
      saveQueuedRef.current = true;
      return saveInFlightRef.current;
    }
    saveQueuedRef.current = false;

    const saveDraft = currentDraftRef.current!;
    if (saveDraft.provider === "koito" && !saveDraft.url) {
      showError("Koito URL is required");
      return;
    }
    let succeeded = false;
    const request = (async () => {
      try {
        setSaving(true);
        const [, lidarrData] = await Promise.all([
          saveHistory({
            listenHistoryProvider: saveDraft.provider,
            listenHistoryUsername: ["koito", "local"].includes(saveDraft.provider)
              ? null
              : saveDraft.username || null,
            listenHistoryUrl: saveDraft.provider === "koito" ? saveDraft.url || null : null,
          }),
          saveLidarr({
            rootFolderPath: saveDraft.rootFolderPath || null,
            qualityProfileId: saveDraft.qualityProfileId
              ? Number(saveDraft.qualityProfileId)
              : null,
          }),
        ]);
        if (!isCurrentAccount(activeAccountIdRef.current, saveAccountId)) return false;
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
        if (isCurrentAccount(activeAccountIdRef.current, saveAccountId)) {
          showError("Failed to save account settings");
        }
        return false;
      }
    })();

    saveInFlightRef.current = request;
    saveInFlightAccountIdRef.current = saveAccountId;
    try {
      return await request;
    } finally {
      if (saveInFlightRef.current === request) {
        saveInFlightRef.current = null;
        saveInFlightAccountIdRef.current = null;
        if (isCurrentAccount(activeAccountIdRef.current, saveAccountId)) {
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
      }
    }
  }, [authUser?.id, saveHistory, saveLidarr, showError]);

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
