import { useEffect, useMemo } from "react";
import { Navigate } from "react-router-dom";
import { useToast } from "../../contexts/ToastContext";
import { useAuth } from "../../contexts/AuthContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useSettingsData } from "./hooks/useSettingsData";
import { useUnsavedGuard } from "./hooks/useUnsavedGuard";
import { useSettingsTabs } from "./hooks/useSettingsTabs";
import { useSettingsUsers } from "./hooks/useSettingsUsers";
import { UnsavedModal } from "./components/UnsavedModal";
import { CommunityGuideModal } from "./components/CommunityGuideModal";
import { SettingsIntegrationsTab } from "./components/SettingsIntegrationsTab";
import { SettingsDiscoverTab } from "./components/SettingsDiscoverTab";
import { SettingsNotificationsTab } from "./components/SettingsNotificationsTab";
import { SettingsUsersTab } from "./components/SettingsUsersTab";
import { SettingsTabsNav } from "./components/SettingsTabsNav";
import { SettingsSelect } from "./components/SettingsField";

function SettingsPage() {
  const { showSuccess, showError, showInfo } = useToast();
  const { user: authUser } = useAuth();

  const data = useSettingsData(showSuccess, showError, showInfo);
  const guard = useUnsavedGuard(
    data.hasUnsavedChanges,
    data.setHasUnsavedChanges,
  );
  const tabs = useSettingsTabs(authUser);
  const users = useSettingsUsers(
    authUser,
    showSuccess,
    showError,
    tabs.activeTab,
  );

  const settingsTitle = useMemo(() => {
    const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeTab);
    return activeTab ? `${activeTab.label} - Settings` : "Settings";
  }, [tabs.activeTab, tabs.tabs]);
  useDocumentTitle(settingsTitle);

  useEffect(() => {
    if (tabs.activeTab === "discover") {
      data.refreshHealth();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when switching to discover tab
  }, [tabs.activeTab]);

  const renderTabContent = () => {
    switch (tabs.activeTab) {
      case "integrations":
        return (
          <SettingsIntegrationsTab
            settings={data.settings}
            updateSettings={data.updateSettings}
            health={data.health}
            lidarrProfiles={data.lidarrProfiles}
            loadingLidarrProfiles={data.loadingLidarrProfiles}
            setLoadingLidarrProfiles={data.setLoadingLidarrProfiles}
            setLidarrProfiles={data.setLidarrProfiles}
            lidarrMetadataProfiles={data.lidarrMetadataProfiles}
            loadingLidarrMetadataProfiles={data.loadingLidarrMetadataProfiles}
            setLoadingLidarrMetadataProfiles={
              data.setLoadingLidarrMetadataProfiles
            }
            setLidarrMetadataProfiles={data.setLidarrMetadataProfiles}
            lidarrTags={data.lidarrTags}
            loadingLidarrTags={data.loadingLidarrTags}
            setLoadingLidarrTags={data.setLoadingLidarrTags}
            setLidarrTags={data.setLidarrTags}
            testingLidarr={data.testingLidarr}
            setTestingLidarr={data.setTestingLidarr}
            applyingCommunityGuide={data.applyingCommunityGuide}
            showCommunityGuideModal={data.showCommunityGuideModal}
            setShowCommunityGuideModal={data.setShowCommunityGuideModal}
            hasUnsavedChanges={data.hasUnsavedChanges}
            saving={data.saving}
            handleSaveSettings={data.handleSaveSettings}
            showSuccess={showSuccess}
            showError={showError}
            showInfo={showInfo}
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
            discoveryProgressMessage={data.discoveryProgressMessage}
            clearingCache={data.clearingCache}
            handleRefreshDiscovery={data.handleRefreshDiscovery}
            handleClearCache={data.handleClearCache}
          />
        );
      case "notifications":
        return (
          <SettingsNotificationsTab
            settings={data.settings}
            updateSettings={data.updateSettings}
            hasUnsavedChanges={data.hasUnsavedChanges}
            saving={data.saving}
            handleSaveSettings={data.handleSaveSettings}
            testingGotify={data.testingGotify}
            setTestingGotify={data.setTestingGotify}
            showSuccess={showSuccess}
            showError={showError}
          />
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

  return (
    <>
      <UnsavedModal
        show={guard.showUnsavedModal}
        onCancel={guard.handleCancelLeave}
        onConfirm={guard.handleConfirmLeave}
      />

      <CommunityGuideModal
        show={data.showCommunityGuideModal}
        onClose={() => data.setShowCommunityGuideModal(false)}
        onApply={data.handleApplyCommunityGuide}
      />

      <div className="settings-page">
        <header className="settings-page__header">
          <h1 className="settings-page__title">Settings</h1>
          <p className="settings-page__subtitle">
            Configure application preferences and integrations
          </p>
        </header>

        <div className="settings-page__mobile-nav">
          <label
            htmlFor="settings-tab-select"
            className="settings-page__mobile-label"
          >
            Section
          </label>
          <SettingsSelect
            id="settings-tab-select"
            value={tabs.activeTab}
            onChange={(event) => tabs.setActiveTab(event.target.value)}
          >
            {tabs.tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.label}
              </option>
            ))}
          </SettingsSelect>
        </div>

        <SettingsTabsNav
          tabs={tabs.tabs}
          activeTab={tabs.activeTab}
          setActiveTab={tabs.setActiveTab}
          navRef={tabs.navRef}
          activeBubbleRef={tabs.activeBubbleRef}
          hoverBubbleRef={tabs.hoverBubbleRef}
          linkRefs={tabs.linkRefs}
          setHoveredTabIndex={tabs.setHoveredTabIndex}
        />

        <div>{renderTabContent()}</div>
      </div>
    </>
  );
}

export default SettingsPage;
