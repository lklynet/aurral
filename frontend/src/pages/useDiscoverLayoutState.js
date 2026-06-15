import { useCallback, useEffect, useState } from "react";

export function useDiscoverLayoutState({
  defaultSections,
  userId,
  normalizeLayout,
  readStoredLayout,
  writeStoredLayout,
  loadServerLayout,
  saveServerLayout,
  showSuccess,
  showError,
}) {
  const getDefaultSections = useCallback(
    () => defaultSections.map((item) => ({ ...item })),
    [defaultSections],
  );
  const [discoverSections, setDiscoverSections] = useState(getDefaultSections);
  const [draftSections, setDraftSections] = useState(getDefaultSections);
  const [showDiscoverModal, setShowDiscoverModal] = useState(false);
  const [isSavingDiscoverLayout, setIsSavingDiscoverLayout] = useState(false);

  useEffect(() => {
    const stored = readStoredLayout(userId);
    setDiscoverSections(stored || getDefaultSections());
  }, [getDefaultSections, readStoredLayout, userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const loadDiscoverLayout = async () => {
      try {
        const response = await loadServerLayout();
        if (cancelled) return;
        const serverLayout = normalizeLayout(response?.layout);
        if (serverLayout) {
          setDiscoverSections(serverLayout);
          writeStoredLayout(serverLayout, userId);
        }
      } catch {
        const localLayout = readStoredLayout(userId);
        if (!cancelled) {
          setDiscoverSections(localLayout || getDefaultSections());
        }
      }
    };
    loadDiscoverLayout();
    return () => {
      cancelled = true;
    };
  }, [
    getDefaultSections,
    loadServerLayout,
    normalizeLayout,
    readStoredLayout,
    userId,
    writeStoredLayout,
  ]);

  const saveDiscoverLayout = useCallback(
    (layout) => {
      const nextLayout = layout.map((item) => ({ ...item }));
      setIsSavingDiscoverLayout(true);
      return saveServerLayout(nextLayout)
        .then((response) => {
          const savedLayout = normalizeLayout(response?.layout) || nextLayout;
          setDiscoverSections(savedLayout);
          writeStoredLayout(savedLayout, userId);
          showSuccess("Discover layout saved");
          setShowDiscoverModal(false);
          return savedLayout;
        })
        .catch((err) => {
          showError(
            err.response?.data?.message || "Failed to save discover layout",
          );
          throw err;
        })
        .finally(() => {
          setIsSavingDiscoverLayout(false);
        });
    },
    [
      normalizeLayout,
      saveServerLayout,
      showError,
      showSuccess,
      userId,
      writeStoredLayout,
    ],
  );

  return {
    discoverSections,
    draftSections,
    setDraftSections,
    showDiscoverModal,
    setShowDiscoverModal,
    isSavingDiscoverLayout,
    saveDiscoverLayout,
  };
}
