import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { DotLoader } from "../../components/DotLoader";
import { useSettingsData } from "./hooks/useSettingsData";
import { useAccountSettings } from "./hooks/useAccountSettings";
import { SettingsPage, SettingsSavingContext } from "./SettingsLayout";
import type { SettingsSectionId } from "./settingsSections";

type ServerSettings = ReturnType<typeof useSettingsData> & ReturnType<typeof useToast>;
type AccountSettings = ReturnType<typeof useAccountSettings>;

const ServerSettingsContext = createContext<ServerSettings | null>(null);
const AccountSettingsContext = createContext<AccountSettings | null>(null);

const HEALTH_SECTIONS = new Set<SettingsSectionId>(["general", "status", "lidarr", "discovery"]);

export function ServerSettingsProvider({
  section,
  children,
}: {
  section: SettingsSectionId;
  children: ReactNode;
}) {
  const toast = useToast();
  const data = useSettingsData(toast.showSuccess, toast.showError, toast.showInfo, section);
  const parentSaving = useContext(SettingsSavingContext);
  const { refreshHealth } = data;

  useEffect(() => {
    if (HEALTH_SECTIONS.has(section)) void refreshHealth();
  }, [refreshHealth, section]);

  return (
    <ServerSettingsContext.Provider value={{ ...data, ...toast }}>
      <SettingsSavingContext.Provider value={parentSaving || data.saving}>
        {children}
      </SettingsSavingContext.Provider>
    </ServerSettingsContext.Provider>
  );
}

export function useServerSettings() {
  const value = useContext(ServerSettingsContext);
  if (!value) throw new Error("useServerSettings must be used inside ServerSettingsProvider");
  return value;
}

export function ServerSettingsGate({ title, children }: { title: string; children: ReactNode }) {
  const { settingsLoaded } = useServerSettings();
  if (settingsLoaded) return children;
  return (
    <SettingsPage title={title}>
      <p className="settings-loading">
        <DotLoader size="sm" label={null} /> Loading settings…
      </p>
    </SettingsPage>
  );
}

export function AccountSettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { showError } = useToast();
  const account = useAccountSettings(user, showError);
  return (
    <AccountSettingsContext.Provider value={account}>
      <SettingsSavingContext.Provider value={account.saving}>
        {children}
      </SettingsSavingContext.Provider>
    </AccountSettingsContext.Provider>
  );
}

export function useAccountSettingsContext() {
  const value = useContext(AccountSettingsContext);
  if (!value)
    throw new Error("useAccountSettingsContext must be used inside AccountSettingsProvider");
  return value;
}
