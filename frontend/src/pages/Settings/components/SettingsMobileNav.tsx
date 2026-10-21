import type { ChangeEvent } from "react";
import { SettingsSelect } from "./SettingsField";

export function SettingsMobileNav({
  tabs,
  activeTab,
  onSelectTab,
}: {
  tabs: readonly { id: string; label: string }[];
  activeTab: string;
  onSelectTab: (tabId: string) => void;
}) {
  return (
    <div className="settings-arr__mobile-nav">
      <label htmlFor="settings-tab-select" className="settings-arr__mobile-label">
        Section
      </label>
      <SettingsSelect
        id="settings-tab-select"
        value={activeTab}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onSelectTab(event.target.value)}
      >
        {tabs.map((tab) => (
          <option key={tab.id} value={tab.id}>
            {tab.label}
          </option>
        ))}
      </SettingsSelect>
    </div>
  );
}
