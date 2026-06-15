import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { useToast } from "../../contexts/ToastContext";
import { useAuth } from "../../contexts/AuthContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useSettingsData } from "./hooks/useSettingsData";
import { useUnsavedGuard } from "./hooks/useUnsavedGuard";
import { UnsavedModal } from "./components/UnsavedModal";
import { SettingsMetadataTab } from "./components/SettingsMetadataTab";
import SettingsMetadataSponsorSection from "../../components/SettingsMetadataSponsorSection";

function MetadataProvidersPage() {
  useDocumentTitle("Metadata Providers");
  const { showSuccess, showError, showInfo } = useToast();
  const { user: authUser } = useAuth();
  const data = useSettingsData(showSuccess, showError, showInfo);
  const guard = useUnsavedGuard(
    data.hasUnsavedChanges,
    data.setHasUnsavedChanges,
  );

  useEffect(() => {
    data.refreshHealth();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (authUser?.role !== "admin") {
    return <Navigate to="/settings" replace />;
  }

  return (
    <>
      <UnsavedModal
        show={guard.showUnsavedModal}
        onCancel={guard.handleCancelLeave}
        onConfirm={guard.handleConfirmLeave}
      />

      <div className="settings-page">
        <header className="settings-page__header">
          <h1 className="settings-page__title">Metadata Providers</h1>
          <p className="settings-page__subtitle">
            Configure metadata hydration and the Aurral Search catalog backend.
          </p>
        </header>

        <SettingsMetadataSponsorSection />

        <SettingsMetadataTab
          settings={data.settings}
          updateSettings={data.updateSettings}
          health={data.health}
          hasUnsavedChanges={data.hasUnsavedChanges}
          saving={data.saving}
          handleSaveSettings={data.handleSaveSettings}
        />
      </div>
    </>
  );
}

export default MetadataProvidersPage;
