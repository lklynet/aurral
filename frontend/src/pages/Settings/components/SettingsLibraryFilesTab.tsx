import { useEffect, useRef, useState } from "react";
import { parseResponse, type InferResponseType } from "hono/client";
import { FolderInput, FolderPlus, FolderSync, Trash2 } from "../../../components/icons";
import { ConfirmModal } from "../../../components/ConfirmModal";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { DotLoader } from "../../../components/DotLoader";
import LibraryFileOperation from "../../../components/LibraryFileOperation";
import PillToggle from "../../../components/PillToggle";
import {
  ACTIVE_LIBRARY_FILE_STATUSES,
  refreshLibraryFiles,
  useLibraryFileOperation,
  useLibraryFiles,
  useReadOnlyFolders,
} from "../../../hooks/useLibraryFileOperation.ts";
import { libraryFilesClient } from "../../../utils/api/clients/libraryFiles.ts";
import type { ComponentProps } from "react";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsSelect } from "./SettingsField";
import type { useToast } from "../../../contexts/ToastContext";
import { readApiError } from "../utils/apiError.ts";

type Toast = ReturnType<typeof useToast>["showSuccess"];
type FileOperation = ComponentProps<typeof LibraryFileOperation>["operation"];
type ReadOnlyFolder = {
  path: string;
  readable: boolean;
  tracks: number;
  lidarrRoot: string | null;
};

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

const errorMessage = (error: unknown, fallback: string) => {
  const failure = readApiError(error);
  return failure.message || failure.text || fallback;
};

const trackCount = (count: number) => `${count.toLocaleString()} track${count === 1 ? "" : "s"}`;

function folderStatus(folder: ReadOnlyFolder, scanning: boolean) {
  if (!folder.readable) return { text: "Aurral cannot read this folder.", warning: true };
  if (folder.lidarrRoot) return { text: "Lidarr manages this folder while Lidarr is on." };
  if (scanning && folder.tracks === 0) return { text: "Scanning…" };
  return { text: trackCount(folder.tracks) };
}

function ReadOnlyFoldersSection({
  onChanged,
  showError,
}: {
  onChanged: () => Promise<void>;
  showError: Toast;
}) {
  const query = useReadOnlyFolders();
  const [draft, setDraft] = useState("");
  const [fieldKey, setFieldKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const folders: ReadOnlyFolder[] = query.data?.folders || [];
  const scanning = query.data?.scanning === true;

  const add = async () => {
    setAdding(true);
    setAddError("");
    try {
      await parseResponse(
        libraryFilesClient.files["read-only-folders"].$post({ json: { path: draft } }),
      );
      setDraft("");
      setFieldKey((key) => key + 1);
      await onChanged();
    } catch (error) {
      setAddError(errorMessage(error, "Aurral could not add this folder. Nothing was changed."));
    } finally {
      setAdding(false);
    }
  };

  const remove = async () => {
    setRemoveBusy(true);
    try {
      await parseResponse(
        libraryFilesClient.files["read-only-folders"].$delete({ json: { path: removing } }),
      );
      setRemoving(null);
      await onChanged();
    } catch (error) {
      showError(errorMessage(error, "Aurral could not remove this folder. Nothing was changed."));
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <SettingsArrFieldSet legend="Read-only folders">
      <div className="arr-info">
        Aurral adds the music in these folders to the Library and never changes, moves, or deletes
        it. New downloads go to the Downloads Folder.
      </div>
      <div className="arr-table-wrap">
        <table className="arr-table">
          <thead>
            <tr>
              <th scope="col">Folder</th>
              <th scope="col">Library</th>
              <th scope="col" className="arr-table__actions-head">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr className="arr-table__empty-row">
                <td colSpan={3}>Loading folders…</td>
              </tr>
            ) : query.isError ? (
              <tr className="arr-table__empty-row">
                <td colSpan={3}>Could not load read-only folders. Reload the page to try again.</td>
              </tr>
            ) : folders.length === 0 ? (
              <tr className="arr-table__empty-row">
                <td colSpan={3}>No read-only folders. Add one below.</td>
              </tr>
            ) : (
              folders.map((folder) => {
                const status = folderStatus(folder, scanning);
                return (
                  <tr key={folder.path}>
                    <td>
                      <code className="arr-table__path">{folder.path}</code>
                    </td>
                    <td
                      className={status.warning ? "arr-form-help--warning" : undefined}
                      aria-live="polite"
                    >
                      {status.text}
                    </td>
                    <td className="arr-table__actions">
                      <div className="arr-table__actions-inner">
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          aria-label={`Remove read-only folder ${folder.path}`}
                          onClick={() => setRemoving(folder.path)}
                        >
                          <Trash2 className="artist-icon-sm" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <SettingsArrFormGroup
        label="Add a folder"
        labelFor="library-read-only-folder"
        help={addError || "Choose a folder outside the Downloads Folder."}
        helpWarning={Boolean(addError)}
      >
        <DownloadFolderField
          key={fieldKey}
          id="library-read-only-folder"
          value={draft}
          suggestFolder={false}
          createOnConfirm={false}
          onChange={(value: string) => {
            setDraft(value);
            setAddError("");
          }}
        />
      </SettingsArrFormGroup>
      <div className="settings-library-files__actions">
        <button
          type="button"
          className="arr-btn arr-btn--primary"
          disabled={!draft || adding}
          onClick={add}
        >
          {adding ? (
            <DotLoader size="sm" label={null} />
          ) : (
            <FolderPlus className="artist-icon-xs" aria-hidden />
          )}
          Add folder
        </button>
      </div>
      <ConfirmModal
        open={Boolean(removing)}
        title="Remove this read-only folder?"
        body={`The music in ${removing} leaves the Library. The files stay on disk. Playlist and flow tracks that use them download again.`}
        confirmLabel="Remove folder"
        busyLabel="Removing…"
        busy={removeBusy}
        onCancel={() => setRemoving(null)}
        onConfirm={remove}
      />
    </SettingsArrFieldSet>
  );
}

function IngestSection({
  busy,
  operation,
  onChanged,
  showError,
}: {
  busy: boolean;
  operation: FileOperation | null;
  onChanged: () => Promise<void>;
  showError: Toast;
}) {
  const [sourcePath, setSourcePath] = useState("");
  const [mode, setMode] = useState<keyof typeof MODE_HELP>("copy");
  const [monitor, setMonitor] = useState<keyof typeof MONITOR_HELP>("tracks");
  const [fillTags, setFillTags] = useState(true);
  const [check, setCheck] = useState<{
    loading: boolean;
    result: InferResponseType<typeof libraryFilesClient.files.ingest.check.$post, 200> | null;
    error: string;
  }>({ loading: false, result: null, error: "" });
  const [starting, setStarting] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!sourcePath) {
      setCheck({ loading: false, result: null, error: "" });
      return;
    }
    setCheck({ loading: true, result: null, error: "" });
    parseResponse(libraryFilesClient.files.ingest.check.$post({ json: { sourcePath } }))
      .then((result) => {
        if (requestId !== requestRef.current) return;
        setCheck({ loading: false, result, error: "" });
        if (!result.hardlink?.available)
          setMode((current) => (current === "hardlink" ? "copy" : current));
      })
      .catch((error) => {
        if (requestId === requestRef.current) {
          setCheck({
            loading: false,
            result: null,
            error: errorMessage(error, "Aurral could not check this folder."),
          });
        }
      });
  }, [sourcePath]);

  const result = check.result;
  const hardlinkUnavailable = result && !result.hardlink?.available;
  const folderHelp = check.loading
    ? "Checking the folder…"
    : check.error ||
      (result
        ? `${result.audioFiles} music file${result.audioFiles === 1 ? "" : "s"} found.`
        : "Choose a folder outside the Downloads Folder.");

  const start = async () => {
    setStarting(true);
    try {
      await parseResponse(
        libraryFilesClient.files.ingest.$post({
          json: { sourcePath: result!.sourcePath, mode, monitor, fillTags },
        }),
      );
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
        Imports music into the Downloads Folder, where Aurral manages it with Aurral naming.
        Existing files are never overwritten. To let Aurral see a folder without changing it, add it
        as a read-only folder instead.
      </div>
      <SettingsArrFormGroup
        label="Folder"
        labelFor="library-ingest-source"
        help={folderHelp}
        helpWarning={Boolean(check.error)}
      >
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
        help={
          mode === "copy" && hardlinkUnavailable
            ? `${MODE_HELP.copy} Hardlink is not available: ${result.hardlink.reason}`
            : MODE_HELP[mode]
        }
      >
        <SettingsSelect
          id="library-ingest-mode"
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "move" || next === "copy" || next === "hardlink") setMode(next);
          }}
        >
          <option value="move">Move</option>
          <option value="copy">Copy</option>
          <option value="hardlink" disabled={Boolean(hardlinkUnavailable)}>
            Hardlink
          </option>
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
      <SettingsArrFormGroup
        label="Monitor"
        labelFor="library-ingest-monitor"
        help={MONITOR_HELP[monitor]}
      >
        <SettingsSelect
          id="library-ingest-monitor"
          value={monitor}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "none" || next === "tracks" || next === "albums") setMonitor(next);
          }}
        >
          <option value="none">None</option>
          <option value="tracks">Tracks</option>
          <option value="albums">Albums</option>
        </SettingsSelect>
      </SettingsArrFormGroup>
      {result?.readOnlyFolder ? (
        <p className="arr-form-help arr-form-help--warning">
          {result.readOnlyFolder} is a read-only folder. Moving files takes them out of it. Copy and
          Hardlink keep its files.
        </p>
      ) : null}
      {result?.lidarrRoot ? (
        <p className="arr-form-help arr-form-help--warning">
          Lidarr uses {result.lidarrRoot}. Moving files breaks its library. Copy and Hardlink keep
          its files.
        </p>
      ) : null}
      <div className="settings-library-files__actions">
        <button
          type="button"
          className="arr-btn arr-btn--primary"
          disabled={!result || !result.audioFiles || busy || starting}
          onClick={start}
        >
          {starting ? (
            <DotLoader size="sm" label={null} />
          ) : (
            <FolderInput className="artist-icon-xs" aria-hidden />
          )}
          Import folder
        </button>
      </div>
      <LibraryFileOperation operation={operation} onChanged={onChanged} showError={showError} />
    </SettingsArrFieldSet>
  );
}

export function SettingsLibraryFilesTab({ showError }: { showError: Toast }) {
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
      await parseResponse(libraryFilesClient.files.cleanup.$post());
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
        <ReadOnlyFoldersSection onChanged={refresh} showError={showError} />

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
              {cleaningUp ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <FolderSync className="artist-icon-xs" aria-hidden />
              )}
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
          <p className="arr-form-help arr-form-help--warning">
            Could not load library file operations. Reload the page to try again.
          </p>
        ) : null}
      </div>
    </div>
  );
}
