import { useEffect, useRef, useState } from "react";
import { FolderInput, FolderSync } from "lucide-react";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { DotLoader } from "../../../components/DotLoader";
import LibraryFileOperation, { LibraryFileOperationActions } from "../../../components/LibraryFileOperation";
import PillToggle from "../../../components/PillToggle";
import {
  ACTIVE_LIBRARY_FILE_STATUSES,
  refreshLibraryFiles,
  useLibraryFileOperation,
  useLibraryFiles,
} from "../../../hooks/useLibraryFileOperation.js";
import {
  checkLibraryIngestSource,
  startLibraryIngest,
  startLibraryOrganize,
} from "../../../utils/api/endpoints/library.js";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsSelect } from "./SettingsField";

const MODE_HELP = {
  move: "Moves each file into the Downloads Folder. Empty source folders are removed.",
  copy: "Copies each file. The source folder stays as it is, and the music takes twice the space.",
  hardlink: "Links each file into the Downloads Folder without using more space. Retagging or upgrading a linked file later gives the Library its own copy.",
};

const ACTION_NAMES = { rename: "rename files", retag: "write tags", upgrade: "search for upgrades" };

const listActions = (actions) => {
  const names = actions.map((action) => ACTION_NAMES[action]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "";
};

const errorMessage = (error, fallback) =>
  error?.response?.data?.message || error?.message || fallback;

function operationTitle(operation) {
  if (!operation) return "";
  if (operation.kind === "ingest") return `Ingest from ${operation.options?.sourcePath || "a folder"}`;
  const scope = operation.options?.scope?.kind;
  return scope === "artist" ? "Organize an artist" : scope === "album" ? "Organize an album" : "Organize the Library";
}

function IngestSection({ busy, onStarted, showError }) {
  const [sourcePath, setSourcePath] = useState("");
  const [mode, setMode] = useState("copy");
  const [check, setCheck] = useState({ loading: false, result: null, error: "" });
  const [starting, setStarting] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!sourcePath) {
      setCheck({ loading: false, result: null, error: "" });
      return;
    }
    setCheck({ loading: true, result: null, error: "" });
    checkLibraryIngestSource(sourcePath)
      .then((result) => {
        if (requestId !== requestRef.current) return;
        setCheck({ loading: false, result, error: "" });
        if (!result.hardlink?.available) setMode((current) => (current === "hardlink" ? "copy" : current));
      })
      .catch((error) => {
        if (requestId === requestRef.current) {
          setCheck({ loading: false, result: null, error: errorMessage(error, "Aurral could not check this folder.") });
        }
      });
  }, [sourcePath]);

  const result = check.result;
  const hardlinkUnavailable = result && !result.hardlink?.available;
  const folderHelp = check.loading
    ? "Checking the folder…"
    : check.error
      || (result
        ? `${result.audioFiles} music file${result.audioFiles === 1 ? "" : "s"} found.`
        : "A folder outside the Downloads Folder, such as an old library or a Lidarr root folder.");

  const start = async () => {
    setStarting(true);
    try {
      await startLibraryIngest(result.sourcePath, mode);
      await onStarted();
    } catch (error) {
      showError(errorMessage(error, "The ingest could not start. Nothing was changed."));
    } finally {
      setStarting(false);
    }
  };

  return (
    <SettingsArrFieldSet legend="Ingest a folder">
      <div className="arr-info">
        Bring music from another folder into the Downloads Folder under Aurral&apos;s names. Aurral never
        overwrites a file. New artists and albums start Not monitored.
      </div>
      <SettingsArrFormGroup label="Folder" labelFor="library-ingest-source" help={folderHelp} helpWarning={Boolean(check.error)}>
        <DownloadFolderField
          id="library-ingest-source"
          value={sourcePath}
          suggestFolder={false}
          createOnConfirm={false}
          onChange={setSourcePath}
        />
      </SettingsArrFormGroup>
      <SettingsArrFormGroup
        label="Mode"
        labelFor="library-ingest-mode"
        help={mode === "copy" && hardlinkUnavailable ? `${MODE_HELP.copy} Hardlink is not available: ${result.hardlink.reason}` : MODE_HELP[mode]}
      >
        <SettingsSelect id="library-ingest-mode" value={mode} onChange={(event) => setMode(event.target.value)}>
          <option value="move">Move</option>
          <option value="copy">Copy</option>
          <option value="hardlink" disabled={Boolean(hardlinkUnavailable)}>Hardlink</option>
        </SettingsSelect>
      </SettingsArrFormGroup>
      {result?.lidarrRoot ? (
        <p className="arr-form-help arr-form-help--warning">
          This folder is in Lidarr&apos;s root folder {result.lidarrRoot}, and Lidarr still points at it.
          {mode === "move"
            ? " Move takes the files away from Lidarr and breaks its library."
            : " Copy and Hardlink leave Lidarr's files where they are."}
        </p>
      ) : null}
      <div className="settings-library-files__actions">
        <button
          type="button"
          className="arr-btn arr-btn--primary"
          disabled={!result || !result.audioFiles || busy || starting}
          onClick={start}
        >
          {starting ? <DotLoader size="sm" label={null} /> : <FolderInput className="artist-icon-xs" aria-hidden />}
          Preview ingest
        </button>
      </div>
    </SettingsArrFieldSet>
  );
}

export function SettingsLibraryFilesTab({
  settings,
  updateSettings,
  hasUnsavedChanges,
  handleSaveSettings,
  showError,
}) {
  const files = useLibraryFiles();
  const operationId = files.data?.operation?.id ?? null;
  const operationQuery = useLibraryFileOperation(operationId);
  const operation = operationQuery.data || files.data?.operation || null;
  const active = operation && ACTIVE_LIBRARY_FILE_STATUSES.has(operation.status);
  const [organizing, setOrganizing] = useState(false);
  const [following, setFollowing] = useState(false);
  const operationRef = useRef(null);

  useEffect(() => {
    if (!following || !operationId) return;
    operationRef.current?.scrollIntoView({ block: "start" });
    setFollowing(false);
  }, [following, operationId]);

  const libraryFiles = settings.libraryFiles || {};
  const upgrade = settings.qualityProfile?.libraryTracks === true;
  const actions = [
    libraryFiles.rename === true && "rename",
    libraryFiles.retag === true && "retag",
    upgrade && "upgrade",
  ].filter(Boolean);

  const update = (patch) => updateSettings({ ...settings, libraryFiles: { ...libraryFiles, ...patch } });
  const refresh = async () => {
    await refreshLibraryFiles();
  };
  const follow = async () => {
    setFollowing(true);
    await refresh();
  };

  const organize = async () => {
    setOrganizing(true);
    try {
      if (hasUnsavedChanges && (await handleSaveSettings()) !== true) return;
      await startLibraryOrganize({ kind: "library" }, actions);
      await follow();
    } catch (error) {
      showError(errorMessage(error, "Organize could not start. Nothing was changed."));
    } finally {
      setOrganizing(false);
    }
  };

  const operationSection = operation ? (
    <div ref={operationRef}>
      <SettingsArrFieldSet
        legend={active ? operationTitle(operation) : `Last run: ${operationTitle(operation)}`}
        actions={<LibraryFileOperationActions operation={operation} onChanged={refresh} showError={showError} />}
      >
        <LibraryFileOperation operation={operation} />
      </SettingsArrFieldSet>
    </div>
  ) : null;

  return (
    <div className="arr-page">
      <form onSubmit={handleSaveSettings} className="arr-form" autoComplete="off">
        {operationSection}
        <SettingsArrFieldSet legend="File naming">
          <div className="arr-info">
            Aurral keeps each track at <code>Artist/Album/07 - Title.flac</code> in the Downloads Folder.
            Downloads, ingest, and renaming use the same names.
          </div>
          <SettingsArrFormGroup
            label="Rename files"
            help="Organize moves Library files to Aurral's names. Playlists, favorites, and media servers follow the files."
          >
            <PillToggle
              className="settings-toggle"
              checked={libraryFiles.rename === true}
              onChange={(event) => update({ rename: event.target.checked })}
              aria-label="Rename files"
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup
            label="Write tags"
            help="Organize writes MusicBrainz IDs, names, track and disc numbers, year, and genre to files that Aurral matches with confidence. A hardlinked file gets its own copy, so the other link keeps its tags."
          >
            <PillToggle
              className="settings-toggle"
              checked={libraryFiles.retag === true}
              onChange={(event) => update({ retag: event.target.checked })}
              aria-label="Write tags"
            />
          </SettingsArrFormGroup>
          <SettingsArrFormGroup
            label="Upgrade every monitored track"
            help="Upgrades also cover monitored tracks that Aurral did not download, following the quality profile in Download clients."
          >
            <PillToggle
              className="settings-toggle"
              checked={upgrade}
              onChange={(event) => updateSettings({
                ...settings,
                qualityProfile: { ...settings.qualityProfile, libraryTracks: event.target.checked },
              })}
              aria-label="Upgrade every monitored track"
            />
          </SettingsArrFormGroup>
        </SettingsArrFieldSet>

        <SettingsArrFieldSet legend="Organize the Library">
          <div className="arr-info">
            {actions.length
              ? `Preview how Aurral would ${listActions(actions)} for every Library file in the Downloads Folder. Lidarr's files stay with Lidarr. To organize one artist or album, use its menu in Library.`
              : "Turn on Rename files, Write tags, or Upgrade every monitored track to organize the Library."}
          </div>
          <div className="settings-library-files__actions">
            <button
              type="button"
              className="arr-btn arr-btn--primary"
              disabled={!actions.length || active || organizing}
              onClick={organize}
            >
              {organizing ? <DotLoader size="sm" label={null} /> : <FolderSync className="artist-icon-xs" aria-hidden />}
              Preview changes
            </button>
          </div>
        </SettingsArrFieldSet>

        <IngestSection busy={Boolean(active)} onStarted={follow} showError={showError} />

        {files.isError ? (
          <p className="arr-form-help arr-form-help--warning">Could not load library file operations. Reload the page to try again.</p>
        ) : null}
      </form>
    </div>
  );
}
