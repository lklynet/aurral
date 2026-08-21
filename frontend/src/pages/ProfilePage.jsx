import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useAccountSettings } from "./Settings/hooks/useAccountSettings";
import { SettingsAccountTab } from "./Settings/components/SettingsAccountTab";
import { DotLoader } from "../components/DotLoader";
import {
  getSidebarStageBackdropEnabled,
  resolveSidebarStageBackdropVariant,
  setSidebarStageBackdropEnabled,
} from "../components/SidebarStageBackdrop";
import "./Settings/settingsArr.css";

function ProfilePage() {
  useDocumentTitle("Profile");
  const { showSuccess, showError } = useToast();
  const { user: authUser } = useAuth();
  const [showSidebarArt, setShowSidebarArt] = useState(() =>
    getSidebarStageBackdropEnabled(authUser?.id),
  );
  useEffect(() => {
    setShowSidebarArt(getSidebarStageBackdropEnabled(authUser?.id));
  }, [authUser?.id]);
  const account = useAccountSettings(authUser, showError);

  return (
    <div className="profile-page profile-page--settings">
      <div className="profile-page__header">
        <div className="profile-page__intro">
          <h1 className="page-title">Profile</h1>
          <p className="page-subtitle">Personal listening history and library defaults</p>
        </div>
        <span
          className={`profile-page__save-state${account.saving ? " is-saving" : ""}`}
          aria-live="polite"
          aria-busy={account.saving}
          aria-hidden={!account.saving}
        >
          {account.saving ? <><DotLoader size="sm" label={null} /> Saving…</> : null}
        </span>
      </div>

      <SettingsAccountTab
        hidePanelHeader
        profileVariant
        listenHistoryProvider={account.listenHistoryProvider}
        setListenHistoryProvider={account.setListenHistoryProvider}
        listenHistoryUsername={account.listenHistoryUsername}
        setListenHistoryUsername={account.setListenHistoryUsername}
        listenHistoryUrl={account.listenHistoryUrl}
        setListenHistoryUrl={account.setListenHistoryUrl}
        lidarrConfigured={account.lidarrConfigured}
        lidarrRootFolders={account.lidarrRootFolders}
        lidarrQualityProfiles={account.lidarrQualityProfiles}
        lidarrRootFolderPath={account.lidarrRootFolderPath}
        setLidarrRootFolderPath={account.setLidarrRootFolderPath}
        lidarrQualityProfileId={account.lidarrQualityProfileId}
        setLidarrQualityProfileId={account.setLidarrQualityProfileId}
        loading={account.loading}
        handleSave={account.handleSave}
        showSuccess={showSuccess}
        showError={showError}
        showSidebarArt={!!resolveSidebarStageBackdropVariant()}
        sidebarArtEnabled={showSidebarArt}
        setSidebarArtEnabled={(enabled) =>
          setShowSidebarArt(setSidebarStageBackdropEnabled(authUser?.id, enabled))
        }
      />
    </div>
  );
}

export default ProfilePage;
