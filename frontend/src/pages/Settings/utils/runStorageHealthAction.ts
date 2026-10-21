type StorageHealthActionOutcome<R> = { saved: false; result: null } | { saved: true; result: R };

export async function runStorageHealthAction<R>({
  hasUnsavedChanges,
  saveSettings,
  refreshStorageHealth,
}: {
  hasUnsavedChanges: boolean;
  saveSettings: () => Promise<boolean>;
  refreshStorageHealth: () => Promise<R>;
}): Promise<StorageHealthActionOutcome<R>> {
  if (hasUnsavedChanges) {
    const saved = await saveSettings();
    if (saved !== true) {
      return { saved: false, result: null };
    }
  }

  return {
    saved: true,
    result: await refreshStorageHealth(),
  };
}
