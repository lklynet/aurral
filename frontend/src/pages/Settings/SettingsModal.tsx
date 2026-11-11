import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { resolveSidebarStageBackdropVariant } from "../../components/SidebarStageBackdrop";
import { Search } from "../../components/icons";
import { useAuth } from "../../contexts/AuthContext";
import { useStorageHealth } from "../../hooks/useStorageHealth";
import {
  SETTINGS_GROUPS,
  resolveSettingsPath,
  searchSettings,
  visibleSettingsSections,
  type SettingsSearchResult,
  type SettingsSectionId,
} from "./settingsSections";
import { SettingsLink, useSettingsRoute } from "../../navigation/settingsRoute";
import { SettingsScrollContext, SettingsShell } from "./SettingsLayout";
import { ServerSettingsGate, ServerSettingsProvider } from "./SettingsProviders";
import { ProfileSection } from "./sections/ProfileSection";
import { ListeningSection } from "./sections/ListeningSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { SharedLinksSection } from "./sections/SharedLinksSection";
import { GeneralSection } from "./sections/GeneralSection";
import { UsersSection } from "./sections/UsersSection";
import { LibrarySection } from "./sections/LibrarySection";
import { MonitoringSection } from "./sections/MonitoringSection";
import { DownloadsSection } from "./sections/DownloadsSection";
import { DiscoverySection } from "./sections/DiscoverySection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { PluginsSection } from "./sections/PluginsSection";
import { StatusSection } from "./sections/StatusSection";
import { MetadataSection } from "./sections/MetadataSection";

const SECTION_COMPONENTS: Record<SettingsSectionId, ComponentType> = {
  profile: ProfileSection,
  listening: ListeningSection,
  appearance: AppearanceSection,
  "shared-links": SharedLinksSection,
  general: GeneralSection,
  users: UsersSection,
  library: LibrarySection,
  monitoring: MonitoringSection,
  downloads: DownloadsSection,
  discovery: DiscoverySection,
  notifications: NotificationsSection,
  plugins: PluginsSection,
  status: StatusSection,
  metadata: MetadataSection,
};

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));

export default function SettingsModal() {
  const { hasPermission, bootstrap } = useAuth();
  const route = useSettingsRoute();
  const isAdmin = hasPermission("accessSettings");
  const { section } = resolveSettingsPath(route.path, isAdmin);
  const sections = visibleSettingsSections(isAdmin);
  const groups = SETTINGS_GROUPS.filter((group) =>
    sections.some((entry) => entry.group === group.id),
  );
  const { hasFailure: hasStorageFailure } = useStorageHealth({ enabled: isAdmin });
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const results = useMemo(
    () =>
      searchSettings(query, {
        canManageServer: isAdmin,
        signInMethods: Boolean(bootstrap?.oidcEnabled || bootstrap?.googleLoginEnabled),
        sidebarArt: resolveSidebarStageBackdropVariant() !== null,
      }),
    [query, isAdmin, bootstrap?.oidcEnabled, bootstrap?.googleLoginEnabled],
  );
  const [target, setTarget] = useState<SettingsSearchResult | null>(null);
  const scrolled = useCallback(() => setTarget(null), []);
  const scroll = useMemo(
    () => ({ group: target?.path === route.path ? target.group : null, scrolled }),
    [target, route.path, scrolled],
  );
  const choose = (result: SettingsSearchResult) => {
    setQuery("");
    setTarget(result.group ? result : null);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditable(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const Section = SECTION_COMPONENTS[section.id];
  const pane =
    section.group === "server" ? (
      <ServerSettingsGate title={section.label}>
        <Section />
      </ServerSettingsGate>
    ) : (
      <Section />
    );

  return (
    <SettingsShell
      label="Settings"
      view={route.path === "" ? "nav" : "pane"}
      onClose={route.close}
      nav={
        <>
          <label className="settings-dialog__search">
            <Search aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              placeholder="Search settings"
              aria-label="Search settings"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                }
                if (event.key === "Enter" && results[0]) {
                  event.preventDefault();
                  choose(results[0]);
                  route.open(results[0].path);
                }
              }}
            />
            <kbd aria-hidden="true">/</kbd>
          </label>
          {query ? (
            <ul className="settings-dialog__results" aria-label="Search results">
              {results.length ? (
                results.map((result) => (
                  <li key={result.key}>
                    <SettingsLink
                      to={result.path}
                      className="settings-dialog__result"
                      onClick={() => choose(result)}
                    >
                      <span>{result.label}</span>
                      {result.label !== result.section.label ? (
                        <span className="settings-dialog__result-section">
                          {result.section.label}
                        </span>
                      ) : null}
                    </SettingsLink>
                  </li>
                ))
              ) : (
                <li className="settings-dialog__results-empty">No matching settings</li>
              )}
            </ul>
          ) : (
            <nav aria-label="Settings sections">
              {groups.map((group) => (
                <div key={group.id} className="settings-dialog__group">
                  {groups.length > 1 ? (
                    <span className="settings-dialog__group-label">{group.label}</span>
                  ) : null}
                  {sections
                    .filter((entry) => entry.group === group.id)
                    .map((entry) => {
                      const Icon = entry.icon;
                      const active = entry.id === section.id;
                      return (
                        <SettingsLink
                          key={entry.id}
                          to={entry.id}
                          className={`settings-dialog__link${active ? " is-active" : ""}`}
                          aria-current={active ? "page" : undefined}
                        >
                          <Icon aria-hidden="true" />
                          <span>{entry.label}</span>
                          {"beta" in entry ? <span className="settings-beta">Beta</span> : null}
                          {entry.id === "status" && hasStorageFailure ? (
                            <span className="settings-dialog__alert">
                              <span className="sr-only">Storage issues</span>
                            </span>
                          ) : null}
                        </SettingsLink>
                      );
                    })}
                </div>
              ))}
            </nav>
          )}
        </>
      }
    >
      <SettingsScrollContext.Provider value={scroll}>
        {isAdmin ? (
          <ServerSettingsProvider section={section.id}>{pane}</ServerSettingsProvider>
        ) : (
          pane
        )}
      </SettingsScrollContext.Provider>
    </SettingsShell>
  );
}
