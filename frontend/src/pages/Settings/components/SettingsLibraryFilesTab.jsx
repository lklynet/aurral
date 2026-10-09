import { useEffect, useRef, useState } from "react";
import { FolderInput, FolderSync } from "lucide-react";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { DotLoader } from "../../../components/DotLoader";
import LibraryFileOperation, { LibraryFileOperationActions } from "../../../components/LibraryFileOperation";
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
  move: "Moves each file into the Downloads Folder. Empty source folders are removed.",
  copy: "Copies each file. The source folder stays as it is, and the music takes twice the space.",
  hardlink: "Links each file into the Downloads Folder without using more space. Upgrading a linked file later gives the Library its own copy.",
};

const MONITOR_HELP = {
  none: "The music is added and left alone. You can monitor it later from Library.",
  tracks: "Each ingested track is upgraded until it meets the quality profile's cutoff, when Automatic upgrades is on in Download clients.",
  albums: "Each ingested track is upgraded, and Aurral downloads the tracks its album is missing.",
};

const errorMessage = (error, fallback) =>
  error?.response?.data?.message || error?.message || fallback;

function operationTitle(operation) {
  if (!operation) return "";
  if (operation.kind === "ingest") return `Ingest from ${operation.options?.sourcePath || "a folder"}`;
  return "Clean up Library";
}

function IngestSection({ busy, onStarted, showError }) {
  const [sourcePath, setSourcePath] = useState("");
  const [mode, setMode] = useState("copy");
  const [monitor, setMonitor] = useState("none");
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
      await startLibraryIngest(result.sourcePath, mode, monitor);
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
        overwrites a file.
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
      <SettingsArrFormGroup label="Monitor" labelFor="library-ingest-monitor" help={MONITOR_HELP[monitor]}>
        <SettingsSelect id="library-ingest-monitor" value={monitor} onChange={(event) => setMonitor(event.target.value)}>
          <option value="none">None</option>
          <option value="tracks">Tracks</option>
          <option value="albums">Albums</option>
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

export function SettingsLibraryFilesTab({ showError }) {
  const files = useLibraryFiles();
  const operationId = files.data?.operation?.id ?? null;
  const operationQuery = useLibraryFileOperation(operationId);
  const operation = operationQuery.data || files.data?.operation || null;
  const active = operation && ACTIVE_LIBRARY_FILE_STATUSES.has(operation.status);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [following, setFollowing] = useState(false);
  const operationRef = useRef(null);

  useEffect(() => {
    if (!following || !operationId) return;
    operationRef.current?.scrollIntoView({ block: "start" });
    setFollowing(false);
  }, [following, operationId]);

  const refresh = async () => {
    await refreshLibraryFiles();
  };
  const follow = async () => {
    setFollowing(true);
    await refresh();
  };

  const cleanUp = async () => {
    setCleaningUp(true);
    try {
      await startLibraryCleanup();
      await follow();
    } catch (error) {
      showError(errorMessage(error, "Clean up could not start. Nothing was changed."));
    } finally {
      setCleaningUp(false);
    }
  };

  return (
    <div className="arr-page">
      <div className="arr-form">
        {operation ? (
          <div ref={operationRef}>
            <SettingsArrFieldSet
              legend={active ? operationTitle(operation) : `Last run: ${operationTitle(operation)}`}
              actions={<LibraryFileOperationActions operation={operation} onChanged={refresh} showError={showError} />}
            >
              <LibraryFileOperation operation={operation} />
            </SettingsArrFieldSet>
          </div>
        ) : null}

        <IngestSection busy={Boolean(active)} onStarted={follow} showError={showError} />

        <SettingsArrFieldSet legend="Clean up Library">
          <div className="arr-info">
            Renames Library files in the Downloads Folder to Aurral&apos;s names, <code>Artist/Album/07 - Title.flac</code>,
            for music you added by hand. Playlists, favorites, and media servers follow the files. Lidarr&apos;s files
            stay with Lidarr. Downloads already get these names.
          </div>
          <div className="settings-library-files__actions">
            <button
              type="button"
              className="arr-btn arr-btn--primary"
              disabled={active || cleaningUp}
              onClick={cleanUp}
            >
              {cleaningUp ? <DotLoader size="sm" label={null} /> : <FolderSync className="artist-icon-xs" aria-hidden />}
              Preview clean up
            </button>
          </div>
        </SettingsArrFieldSet>

        {files.isError ? (
          <p className="arr-form-help arr-form-help--warning">Could not load library file operations. Reload the page to try again.</p>
        ) : null}
      </div>
    </div>
  );
}
