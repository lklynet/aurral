import { useState, type FormEvent } from "react";
import DownloadFolderField from "../../../../components/DownloadFolderField";
import { Pencil, Trash2 } from "../../../../components/icons";
import TooltipButton from "../../../../components/TooltipButton";
import { SettingsInput } from "../../components/SettingsField";
import { Select } from "../../../../components/Select";
import { useServerSettings } from "../../SettingsProviders";
import { useSettingsRoute } from "../../settingsRoute";
import { SettingsActions, SettingsGroup, SettingsPage, SettingsRow } from "../../SettingsLayout";

type ServerSettings = ReturnType<typeof useServerSettings>;
type PathMapping = ReturnType<typeof readPathMappings>[number];

const PATH_MAPPING_SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "lidarr", label: "Lidarr" },
  { value: "slskd", label: "slskd" },
  { value: "nzbget", label: "NZBGet" },
  { value: "sabnzbd", label: "SABnzbd" },
  { value: "tidarr", label: "Tidarr" },
  { value: "deemix", label: "deemix" },
  { value: "plex", label: "Plex" },
  { value: "jellyfin", label: "Jellyfin" },
  { value: "navidrome", label: "Navidrome" },
];

const SOURCE_VALUES = new Set(PATH_MAPPING_SOURCE_OPTIONS.map((option) => option.value));

function normalizeSource(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return SOURCE_VALUES.has(normalized) ? normalized : "all";
}

function coercePathMappings(value: ServerSettings["settings"]["pathMappings"]) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    source: normalizeSource(entry?.source),
    remote: String(entry?.remote || "").trim(),
    local: String(entry?.local || "").trim(),
  }));
}

const readPathMappings = (settings: ServerSettings["settings"]) =>
  coercePathMappings(settings.pathMappings).filter((entry) => entry.remote || entry.local);

const sourceLabel = (source: string) =>
  PATH_MAPPING_SOURCE_OPTIONS.find((option) => option.value === source)?.label || source;

export function resolveMappingItem(settings: ServerSettings["settings"], item: string | null) {
  if (item === "mapping") return { index: null };
  const match = item?.match(/^mapping-(\d+)$/);
  const index = match ? Number(match[1]) : -1;
  return index >= 0 && index < readPathMappings(settings).length ? { index } : null;
}

function useSavePathMappings() {
  const { settings, updateSettings } = useServerSettings();
  return (next: PathMapping[]) =>
    updateSettings({ ...settings, pathMappings: coercePathMappings(next) });
}

export function PathMappingsTable() {
  const { settings } = useServerSettings();
  const save = useSavePathMappings();
  const route = useSettingsRoute();
  const mappings = readPathMappings(settings);

  if (mappings.length === 0) return null;

  return (
    <div className="settings-table-wrap">
      <table className="settings-table">
        <thead>
          <tr>
            <th scope="col">Applies to</th>
            <th scope="col">Remote path</th>
            <th scope="col">Local path</th>
            <th scope="col" className="settings-table__actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((mapping, index) => (
            <tr key={`${mapping.source}-${mapping.remote}-${index}`}>
              <td>{sourceLabel(mapping.source)}</td>
              <td>
                <code className="settings-code">{mapping.remote}</code>
              </td>
              <td>
                <code className="settings-code">{mapping.local}</code>
              </td>
              <td className="settings-table__actions">
                <TooltipButton
                  label="Edit mapping"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => route.open(`downloads/mapping-${index}`)}
                >
                  <Pencil aria-hidden="true" />
                </TooltipButton>
                <TooltipButton
                  label="Delete mapping"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() =>
                    save(mappings.filter((_entry, entryIndex) => entryIndex !== index))
                  }
                >
                  <Trash2 aria-hidden="true" />
                </TooltipButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PathMappingDetail({ index }: { index: number | null }) {
  const { settings } = useServerSettings();
  const save = useSavePathMappings();
  const route = useSettingsRoute();
  const mappings = readPathMappings(settings);
  const existing = index === null ? undefined : mappings[index];
  const [draft, setDraft] = useState(() => existing ?? { source: "all", remote: "", local: "" });
  const [incomplete, setIncomplete] = useState(false);

  const edit = (patch: Partial<PathMapping>) => {
    setIncomplete(false);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const mapping = {
      source: normalizeSource(draft.source),
      remote: draft.remote.trim(),
      local: draft.local.trim(),
    };
    if (!mapping.remote || !mapping.local) {
      setIncomplete(true);
      return;
    }
    save(
      index === null
        ? [...mappings, mapping]
        : mappings.map((entry, entryIndex) => (entryIndex === index ? mapping : entry)),
    );
    route.back();
  };

  return (
    <SettingsPage title={index === null ? "Add mapping" : "Edit mapping"} back="Downloads">
      <SettingsGroup>
        <form onSubmit={submit}>
          <SettingsRow label="Applies to" htmlFor="path-mapping-source">
            <Select
              id="path-mapping-source"
              value={draft.source}
              onChange={(source) => edit({ source })}
              options={PATH_MAPPING_SOURCE_OPTIONS}
            />
          </SettingsRow>
          <SettingsRow
            label="Remote path"
            htmlFor="path-mapping-remote"
            help="The path the other app reports."
          >
            <SettingsInput
              id="path-mapping-remote"
              autoComplete="off"
              spellCheck={false}
              placeholder="/data/media/music"
              value={draft.remote}
              onChange={(event) => edit({ remote: event.target.value })}
            />
          </SettingsRow>
          <SettingsRow
            label="Local path"
            htmlFor="path-mapping-local"
            help="The same folder as Aurral sees it."
          >
            <DownloadFolderField
              id="path-mapping-local"
              value={draft.local}
              suggestFolder={false}
              createOnConfirm={false}
              onChange={(local) => edit({ local })}
            />
          </SettingsRow>
          <SettingsActions
            status={incomplete ? { tone: "error", message: "Enter both paths." } : null}
          >
            <button type="submit" className="btn btn-primary btn-sm">
              {index === null ? "Add mapping" : "Save"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={route.back}>
              Cancel
            </button>
          </SettingsActions>
        </form>
      </SettingsGroup>
    </SettingsPage>
  );
}
