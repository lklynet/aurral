import { useEffect, useRef, useState } from "react";
import { FolderInput, FolderSync } from "lucide-react";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { DotLoader } from "../../../components/DotLoader";
import LibraryFileOperation from "../../../components/LibraryFileOperation";
import PillToggle from "../../../components/PillToggle";
import {
  ACTIVE_LIBRARY_FILE_STATUSES,
  refreshLibraryFiles,
  useLibraryFileOperation,
  useLibraryFiles,
} from "../../../hooks/useLibraryFileOperation.js";
import {
  checkLibraryIngestSource,
  startLibraryCleanup,
  startLibraryIngest,
} from "../../../utils/api/endpoints/library.js";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsSelect } from "./SettingsField";

const MODE_HELP = {
  move: "Moves files to the Downloads Folder and removes empty source folders.",
  copy: "Keeps source files and uses space for a second copy.",
  hardlink: "Uses no extra space until tags change or a file is upgraded. Source files stay.",
};

const MONITOR_HELP = {
  none: "No automatic upgrades. Enable monitoring later in Library.",
  tracks: "Upgrades imported tracks to the quality cutoff when Automatic upgrades is enabled.",
  albums: "Upgrades imported tracks and downloads missing album tracks.",
};

const FILL_TAGS_HELP = "Fills missing MusicBrainz tags. Existing tags stay.";

const errorMessage = (error, fallback) =>
  error?.response?.data?.message || error?.message || fallback;

function IngestSection({ busy, operation, onChanged, showError }) {
  const [sourcePath, setSourcePath] = useState("");
  const [mode, setMode] = useState("copy");
  const [monitor, setMonitor] = useState("tracks");
  const [fillTags, setFillTags] = useState(true);
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
        : "Choose a folder outside the Downloads Folder.");

  const start = async () => {
    setStarting(true);
    try {
      await startLibraryIngest(result.sourcePath, mode, { monitor, fillTags });
      await onChanged();
    } catch (error) {
      showError(errorMessage(error, "The ingest could not start. Nothing was changed."));
    } finally {
      setStarting(false);
    }
  };

  return (
    <SettingsArrFieldSet legend="Import a folder">
      <div className="arr-info">
        Imports music into the Downloads Folder using Aurral naming. Existing files are never overwritten.
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
      <SettingsArrFormGroup label="Fill in missing tags" help={FILL_TAGS_HELP}>
        <PillToggle
          className="settings-toggle"
          checked={fillTags}
          onChange={(event) => setFillTags(event.target.checked)}
          aria-label="Fill in missing tags"
        />
      </SettingsArrFormGroup>
      <SettingsArrFormGroup label="Monitor" labelFor="library-ingest-monitor" help={MONITOR_HELP[monitor]}>
        <SettingsSelect id="library-ingest-monitor" value={monitor} onChange={(event) => setMonitor(event.target.value)}>
          <option value="none">None</option>
          <option value="tracks">Tracks</option>
          <option value="albums">Albums</option>
        </SettingsSelect>
      </SettingsArrFormGroup>
      {result?.lidarrRoot ? (
        <p className="arr-form-help arr-form-help--warning">
          Lidarr uses {result.lidarrRoot}. Moving files breaks its library. Copy and Hardlink keep its files.
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
          Import folder
        </button>
      </div>
      <LibraryFileOperation operation={operation} onChanged={onChanged} showError={showError} />
    </SettingsArrFieldSet>
  );
}

export function SettingsLibraryFilesTab({ showError }) {
  const files = useLibraryFiles();
  const operationId = files.data?.operation?.id ?? null;
  const operationQuery = useLibraryFileOperation(operationId);
  const operation = operationQuery.data || files.data?.operation || null;
  const active = Boolean(operation && ACTIVE_LIBRARY_FILE_STATUSES.has(operation.status));
  const [cleaningUp, setCleaningUp] = useState(false);

  const refresh = async () => {
    await refreshLibraryFiles();
  };

  const cleanUp = async () => {
    setCleaningUp(true);
    try {
      await startLibraryCleanup();
      await refresh();
    } catch (error) {
      showError(errorMessage(error, "Clean up could not start. Nothing was changed."));
    } finally {
      setCleaningUp(false);
    }
  };

  return (
    <div className="arr-page">
      <div className="arr-form">
        <IngestSection
          busy={active}
          operation={operation?.kind === "ingest" ? operation : null}
          onChanged={refresh}
          showError={showError}
        />

        <SettingsArrFieldSet legend="Clean up Library">
          <div className="arr-info">
            Organizes files in the Downloads Folder and fills missing tags. Playlists, favorites,
            and media servers follow the files. Lidarr files stay untouched. When names clash,
            Aurral keeps the better copy and offers to delete the other.
          </div>
          <div className="settings-library-files__actions">
            <button
              type="button"
              className="arr-btn arr-btn--primary"
              disabled={active || cleaningUp}
              onClick={cleanUp}
            >
              {cleaningUp ? <DotLoader size="sm" label={null} /> : <FolderSync className="artist-icon-xs" aria-hidden />}
              Clean up Library
            </button>
          </div>
          <LibraryFileOperation
            operation={operation?.kind === "cleanup" ? operation : null}
            onChanged={refresh}
            showError={showError}
          />
        </SettingsArrFieldSet>

        {files.isError ? (
          <p className="arr-form-help arr-form-help--warning">Could not load library file operations. Reload the page to try again.</p>
        ) : null}
      </div>
    </div>
  );
}
