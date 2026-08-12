import { useEffect, useMemo } from "react";
import { Navigate, useParams } from "react-router-dom";
import { useToast } from "../../contexts/ToastContext";
import { useAuth } from "../../contexts/AuthContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import SettingsMetadataSponsorSection from "../../components/SettingsMetadataSponsorSection";
import { useSettingsData } from "./hooks/useSettingsData";
import { useSettingsTabs } from "./hooks/useSettingsTabs";
import { useSettingsUsers } from "./hooks/useSettingsUsers";
import { CommunityGuideModal } from "./components/CommunityGuideModal";
import { SettingsMobileNav } from "./components/SettingsMobileNav";
import { SettingsStorageHealthTab } from "./components/SettingsStorageTab";
import { SettingsSystemTab } from "./components/SettingsSystemTab";
import { LidarrSettingsSection } from "./components/LidarrSettingsModalContent";
import { SettingsIndexersSection } from "./components/SettingsIndexersSection";
import { SettingsDownloadClientsSection } from "./components/SettingsDownloadClientsSection";
import { SettingsTasksTab } from "./components/SettingsTasksTab";
import { SettingsPlaybackTab } from "./components/SettingsPlaybackTab";
import { SettingsConnectTab } from "./components/SettingsConnectTab";
import { SettingsRssNewsTab } from "./components/SettingsRssNewsTab";
import { SettingsDiscoverTab } from "./components/SettingsDiscoverTab";
import { SettingsUsersTab } from "./components/SettingsUsersTab";
import { SettingsMetadataTab } from "./components/SettingsMetadataTab";
import { DEFAULT_SETTINGS_TAB, normalizeSettingsTabId } from "./settingsTabsConfig";
import "./settingsArr.css";

function SettingsPage() {
  const { showSuccess, showError, showInfo } = useToast();
  const { user: authUser } = useAuth();
  const { tab: tabParam } = useParams();

  const data = useSettingsData(showSuccess, showError, showInfo);

  const tabs = useSettingsTabs(authUser);

  const users = useSettingsUsers(authUser, showSuccess, showError, tabs.activeTab);

  const normalizedParam = normalizeSettingsTabId(tabParam);
  const shouldRedirect = authUser?.role === "admin" && tabParam && normalizedParam !== tabParam;

  const settingsTitle = useMemo(() => {
    return tabs.activeTabMeta ? `${tabs.activeTabMeta.label} - Settings` : "Settings";
  }, [tabs.activeTabMeta]);
  useDocumentTitle(settingsTitle);

  useEffect(() => {
    if (
      tabs.activeTab === "discover" ||
      tabs.activeTab === "system" ||
      tabs.activeTab === "storage-health"
    ) {
      data.refreshHealth();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.activeTab]);

  const handleTabSelect = (tabId) => {
    tabs.setActiveTab(tabId);
  };

  const renderTabContent = () => {
    switch (tabs.activeTab) {
      case "system":
        return (
          <SettingsSystemTab
            key="settings-system"
            health={data.health}
            settings={data.settings}
            updateSettings={data.updateSettings}
            showSuccess={showSuccess}
            showError={showError}
          />
        );
      case "storage-health":
        return (
          <SettingsStorageHealthTab
            key="settings-storage-health"
            hasUnsavedChanges={data.hasUnsavedChanges}
            handleSaveSettings={data.handleSaveSettings}
            health={data.health}
            showSuccess={showSuccess}
            showError={showError}
          />
        );
      case "lidarr":
        return (
          <div key="settings-lidarr" className="arr-page">
            <form onSubmit={data.handleSaveSettings} className="arr-form" autoComplete="off">
              <LidarrSettingsSection
                settings={data.settings}
                updateSettings={data.updateSettings}
                health={data.health}
                lidarrRootFolders={data.lidarrRootFolders}
                loadingLidarrRootFolders={data.loadingLidarrRootFolders}
                setLoadingLidarrRootFolders={data.setLoadingLidarrRootFolders}
                setLidarrRootFolders={data.setLidarrRootFolders}
                lidarrProfiles={data.lidarrProfiles}
                loadingLidarrProfiles={data.loadingLidarrProfiles}
                setLoadingLidarrProfiles={data.setLoadingLidarrProfiles}
                setLidarrProfiles={data.setLidarrProfiles}
                lidarrMetadataProfiles={data.lidarrMetadataProfiles}
                loadingLidarrMetadataProfiles={data.loadingLidarrMetadataProfiles}
                setLoadingLidarrMetadataProfiles={data.setLoadingLidarrMetadataProfiles}
                setLidarrMetadataProfiles={data.setLidarrMetadataProfiles}
                lidarrTags={data.lidarrTags}
                loadingLidarrTags={data.loadingLidarrTags}
                setLoadingLidarrTags={data.setLoadingLidarrTags}
                setLidarrTags={data.setLidarrTags}
                testingLidarr={data.testingLidarr}
                setTestingLidarr={data.setTestingLidarr}
                applyingCommunityGuide={data.applyingCommunityGuide}
                setShowCommunityGuideModal={data.setShowCommunityGuideModal}
                showSuccess={showSuccess}
                showError={showError}
                showInfo={showInfo}
              />
            </form>
          </div>
        );
      case "indexers":
        return (
          <div className="arr-page">
            <form onSubmit={data.handleSaveSettings} className="arr-form" autoComplete="off">
              <SettingsIndexersSection
                settings={data.settings}
                updateSettings={data.updateSettings}
                health={data.health}
                handleSaveSettings={data.handleSaveSettings}
                showSuccess={showSuccess}
                showError={showError}
                showInfo={showInfo}
              />
            </form>
          </div>
        );
      case "download-clients":
        return (
          <div className="arr-page">
            <form onSubmit={data.handleSaveSettings} className="arr-form" autoComplete="off">
              <SettingsDownloadClientsSection
                settings={data.settings}
                updateSettings={data.updateSettings}
                health={data.health}
                handleSaveSettings={data.handleSaveSettings}
                showSuccess={showSuccess}
                showError={showError}
                showInfo={showInfo}
              />
            </form>
          </div>
        );
      case "tasks":
        return <SettingsTasksTab showError={showError} showSuccess={showSuccess} />;
      case "playback":
        return (
          <SettingsPlaybackTab
            settings={data.settings}
            playbackSettings={data.playbackSettings}
            updateSettings={data.updateSettings}
            hasUnsavedChanges={data.hasUnsavedChanges}
            saving={data.saving}
            handleSaveSettings={data.handleSaveSettings}
            showSuccess={showSuccess}
            showError={showError}
            showInfo={showInfo}
          />
        );
      case "connect":
        return (
          <SettingsConnectTab
            settings={data.settings}
            updateSettings={data.updateSettings}
            health={data.health}
            hasUnsavedChanges={data.hasUnsavedChanges}
            saving={data.saving}
            handleSaveSettings={data.handleSaveSettings}
            testingGotify={data.testingGotify}
            setTestingGotify={data.setTestingGotify}
            showSuccess={showSuccess}
            showError={showError}
          />
        );
      case "rss-news":
        return (
          <SettingsRssNewsTab
            settings={data.settings}
            updateSettings={data.updateSettings}
            handleSaveSettings={data.handleSaveSettings}
          />
        );
      case "discover":
        return (
          <SettingsDiscoverTab
            settings={data.settings}
            updateSettings={data.updateSettings}
            health={data.health}
            hasUnsavedChanges={data.hasUnsavedChanges}
            saving={data.saving}
            handleSaveSettings={data.handleSaveSettings}
            refreshingDiscovery={data.refreshingDiscovery}
            discoveryProgress={data.discoveryProgress}
            discoveryProgressMessage={data.discoveryProgressMessage}
            clearingCache={data.clearingCache}
            handleRefreshDiscovery={data.handleRefreshDiscovery}
            handleClearCache={data.handleClearCache}
          />
        );
      case "metadata":
        return (
          <>
            <SettingsMetadataSponsorSection />
            <SettingsMetadataTab
              settings={data.settings}
              updateSettings={data.updateSettings}
              health={data.health}
              handleSaveSettings={data.handleSaveSettings}
              hidePanelHeader
            />
          </>
        );
      case "users":
        return (
          <SettingsUsersTab
            authUser={authUser}
            usersList={users.usersList}
            loadingUsers={users.loadingUsers}
            newUserUsername={users.newUserUsername}
            setNewUserUsername={users.setNewUserUsername}
            newUserPassword={users.newUserPassword}
            setNewUserPassword={users.setNewUserPassword}
            newUserPermissions={users.newUserPermissions}
            setNewUserPermissions={users.setNewUserPermissions}
            creatingUser={users.creatingUser}
            setCreatingUser={users.setCreatingUser}
            showAddUserModal={users.showAddUserModal}
            setShowAddUserModal={users.setShowAddUserModal}
            editUser={users.editUser}
            setEditUser={users.setEditUser}
            editPassword={users.editPassword}
            setEditPassword={users.setEditPassword}
            editCurrentPassword={users.editCurrentPassword}
            setEditCurrentPassword={users.setEditCurrentPassword}
            editPermissions={users.editPermissions}
            setEditPermissions={users.setEditPermissions}
            savingEdit={users.savingEdit}
            setSavingEdit={users.setSavingEdit}
            changePwCurrent={users.changePwCurrent}
            setChangePwCurrent={users.setChangePwCurrent}
            changePwNew={users.changePwNew}
            setChangePwNew={users.setChangePwNew}
            changePwConfirm={users.changePwConfirm}
            setChangePwConfirm={users.setChangePwConfirm}
            changingPassword={users.changingPassword}
            setChangingPassword={users.setChangingPassword}
            deleteUserTarget={users.deleteUserTarget}
            setDeleteUserTarget={users.setDeleteUserTarget}
            deletingUser={users.deletingUser}
            setDeletingUser={users.setDeletingUser}
            refreshUsers={users.refreshUsers}
            createUser={users.createUser}
            updateUser={users.updateUser}
            deleteUser={users.deleteUser}
            changeMyPassword={users.changeMyPassword}
            settings={data.settings}
            updateSettings={data.updateSettings}
            handleSaveSettings={data.handleSaveSettings}
            health={data.health}
            refreshSettingsData={data.fetchSettings}
            showSuccess={showSuccess}
            showError={showError}
          />
        );
      default:
        return null;
    }
  };

  if (tabs.tabs.length === 0) {
    return <Navigate to="/profile" replace />;
  }

  if (!tabParam) {
    return <Navigate to={`/settings/${DEFAULT_SETTINGS_TAB}`} replace />;
  }

  if (shouldRedirect) {
    return <Navigate to={`/settings/${normalizedParam}`} replace />;
  }

  return (
    <>
      <CommunityGuideModal
        show={data.showCommunityGuideModal}
        onClose={() => data.setShowCommunityGuideModal(false)}
        onApply={data.handleApplyCommunityGuide}
      />

      <div className="settings-arr">
        <div className="settings-arr__body">
          <div className="settings-arr__content">
            <SettingsMobileNav
              tabs={tabs.tabs}
              activeTab={tabs.activeTab}
              onSelectTab={handleTabSelect}
            />

            {renderTabContent()}
          </div>
        </div>
      </div>
    </>
  );
}

export default SettingsPage;
