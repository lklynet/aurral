import { useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  DEFAULT_SETTINGS_TAB,
  getSettingsTabById,
  normalizeSettingsTabId,
  getAvailableSettingsTabs,
} from "../settingsTabsConfig";

export function useSettingsTabs(authUser, capabilities) {
  const navigate = useNavigate();
  const { tab: tabParam } = useParams();

  const tabs = useMemo(() => {
    if (authUser?.role !== "admin") {
      return [];
    }
    return getAvailableSettingsTabs(capabilities);
  }, [authUser?.role, capabilities]);

  const activeTab = useMemo(() => {
    const normalized = normalizeSettingsTabId(tabParam);
    const availableIds = tabs.map((tab) => tab.id);
    return availableIds.includes(normalized) ? normalized : availableIds[0] || DEFAULT_SETTINGS_TAB;
  }, [tabParam, tabs]);

  const activeTabMeta = useMemo(() => getSettingsTabById(activeTab), [activeTab]);

  const setActiveTab = useCallback(
    (tabId) => {
      const nextTab = normalizeSettingsTabId(tabId);
      if (nextTab === activeTab) return;
      navigate(`/settings/${nextTab}`);
    },
    [activeTab, navigate],
  );

  return {
    activeTab,
    activeTabMeta,
    setActiveTab,
    tabs,
  };
}
