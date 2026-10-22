export async function runStorageHealthAction({
  hasUnsavedChanges,
  saveSettings,
  refreshStorageHealth,
}) {
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
