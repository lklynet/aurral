import { SettingsSelect } from "./SettingsField";

export function SettingsMobileNav({ tabs, activeTab, onSelectTab }) {
  return (
    <div className="settings-arr__mobile-nav">
      <label htmlFor="settings-tab-select" className="settings-arr__mobile-label">
        Section
      </label>
      <SettingsSelect
        id="settings-tab-select"
        value={activeTab}
        onChange={(event) => onSelectTab(event.target.value)}
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
