import FlipSaveButton from "../components/FlipSaveButton";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAccountSettings } from "./Settings/hooks/useAccountSettings";
import { SettingsAccountTab } from "./Settings/components/SettingsAccountTab";

function ProfilePage() {
  useDocumentTitle("Profile");
  const { showSuccess, showError } = useToast();
  const { user: authUser } = useAuth();
  const account = useAccountSettings(authUser, showSuccess, showError);

  return (
    <div className="profile-page">
      <div className="profile-page__header">
        <div>
          <h1 className="profile-page__title">Profile</h1>
          <p className="profile-page__subtitle">
            Personal listening history and library defaults
          </p>
        </div>
        {!account.loading && (
          <FlipSaveButton
            saving={account.saving}
            disabled={!account.hasUnsavedChanges}
            onClick={account.handleSave}
          />
        )}
      </div>

      <SettingsAccountTab
        hidePanelHeader
        listenHistoryProvider={account.listenHistoryProvider}
        setListenHistoryProvider={account.setListenHistoryProvider}
        listenHistoryUsername={account.listenHistoryUsername}
        setListenHistoryUsername={account.setListenHistoryUsername}
        lidarrConfigured={account.lidarrConfigured}
        lidarrRootFolders={account.lidarrRootFolders}
        lidarrQualityProfiles={account.lidarrQualityProfiles}
        lidarrRootFolderPath={account.lidarrRootFolderPath}
        setLidarrRootFolderPath={account.setLidarrRootFolderPath}
        lidarrQualityProfileId={account.lidarrQualityProfileId}
        setLidarrQualityProfileId={account.setLidarrQualityProfileId}
        hasUnsavedChanges={account.hasUnsavedChanges}
        loading={account.loading}
        saving={account.saving}
        handleSave={account.handleSave}
      />
    </div>
  );
}

export default ProfilePage;
