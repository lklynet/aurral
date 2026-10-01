import { useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router";
import {
  DEFAULT_SETTINGS_TAB,
  getSettingsTabById,
  normalizeSettingsTabId,
  SETTINGS_NAV_TABS,
  SETTINGS_TAB_IDS,
} from "../settingsTabsConfig";

export function useSettingsTabs(authUser) {
  const navigate = useNavigate();
  const { tab: tabParam } = useParams();

  const tabs = useMemo(() => {
    if (authUser?.role !== "admin") {
      return [];
    }
    return SETTINGS_NAV_TABS;
  }, [authUser?.role]);

  const activeTab = useMemo(() => {
    const normalized = normalizeSettingsTabId(tabParam);
    return SETTINGS_TAB_IDS.includes(normalized) ? normalized : DEFAULT_SETTINGS_TAB;
  }, [tabParam]);

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
