import { SettingsStorageHealthSection } from "./SettingsStorageSection";

export function SettingsStorageHealthTab({
  hasUnsavedChanges,
  handleSaveSettings,
  health,
  showSuccess,
  showError,
}) {
  return (
    <div className="arr-page">
      <form onSubmit={handleSaveSettings} className="arr-form" autoComplete="off">
        <SettingsStorageHealthSection
          hasUnsavedChanges={hasUnsavedChanges}
          handleSaveSettings={handleSaveSettings}
          health={health}
          showSuccess={showSuccess}
          showError={showError}
        />
      </form>
    </div>
  );
}
