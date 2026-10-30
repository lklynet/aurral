import { useEffect, useRef, useState, type ComponentProps } from "react";
import { parseResponse, type InferResponseType } from "hono/client";
import { Trash2 } from "../../../components/icons";
import { ConfirmModal } from "../../../components/ConfirmModal";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { DotLoader } from "../../../components/DotLoader";
import LibraryFileOperation from "../../../components/LibraryFileOperation";
import PillToggle from "../../../components/PillToggle";
import TooltipButton from "../../../components/TooltipButton";
import {
  ACTIVE_LIBRARY_FILE_STATUSES,
  refreshLibraryFiles,
  useLibraryFileOperation,
  useLibraryFiles,
  useReadOnlyFolders,
} from "../../../hooks/useLibraryFileOperation.ts";
import { libraryFilesClient } from "../../../utils/api/clients/libraryFiles.ts";
import { RootOverlapWarning } from "../components/RootOverlapWarning";
import { Select } from "../../../components/Select";
import { readApiError } from "../utils/apiError.ts";
import { useServerSettings } from "../SettingsProviders";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
} from "../SettingsLayout";
import "./library.css";

type FileOperation = ComponentProps<typeof LibraryFileOperation>["operation"];
type ReadOnlyFolder = InferResponseType<
  (typeof libraryFilesClient.files)["read-only-folders"]["$get"],
  200
>["folders"][number];

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

const OUTSIDE_DOWNLOADS = "Choose a folder outside the Downloads Folder.";

const errorMessage = (error: unknown, fallback: string) => {
  const failure = readApiError(error);
  return failure.message || failure.text || fallback;
};

const countLabel = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

function folderStatus(folder: ReadOnlyFolder, scanning: boolean) {
  if (!folder.readable) return { text: "Aurral cannot read this folder.", warning: true };
  if (folder.lidarrRoot) return { text: "Lidarr manages this folder while Lidarr is on." };
  if (scanning && folder.tracks === 0) return { text: "Scanning…" };
  return { text: countLabel(folder.tracks, "track") };
}

function DownloadsFolderGroup() {
  const { settings, updateSettings } = useServerSettings();
  return (
    <SettingsGroup title="Downloads folder">
      <RootOverlapWarning rootWarnings={settings.rootWarnings} />
      <SettingsRow
        label="Path"
        htmlFor="library-download-folder"
        help="Stores downloaded music, including flow tracks."
      >
        <DownloadFolderField
          id="library-download-folder"
          value={settings.downloadFolderPath || ""}
          autoApplySuggestion={false}
          onChange={(downloadFolderPath: string) =>
            updateSettings({ ...settings, downloadFolderPath })
          }
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function ReadOnlyFoldersGroup({ onChanged }: { onChanged: () => Promise<void> }) {
  const { showError } = useServerSettings();
  const query = useReadOnlyFolders();
  const [draft, setDraft] = useState("");
  const [fieldKey, setFieldKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const folders = query.data?.folders ?? [];
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
    <>
      <SettingsGroup
        title="Read-only folders"
        note="Aurral adds the music in these folders to the Library and never changes, moves, or deletes it."
      >
        {query.isPending ? (
          <p className="settings-loading">
            <DotLoader size="sm" label={null} /> Loading folders…
          </p>
        ) : query.isError ? (
          <SettingsNote tone="warning">
            Couldn&apos;t load read-only folders.{" "}
            <button type="button" className="settings-link" onClick={() => query.refetch()}>
              Try again
            </button>
          </SettingsNote>
        ) : folders.length > 0 ? (
          <div className="settings-table-wrap">
            <table className="settings-table">
              <thead>
                <tr>
                  <th scope="col">Folder</th>
                  <th scope="col">Library</th>
                  <th scope="col" className="settings-table__actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {folders.map((folder) => {
                  const status = folderStatus(folder, scanning);
                  return (
                    <tr key={folder.path}>
                      <td>
                        <code className="settings-code">{folder.path}</code>
                      </td>
                      <td
                        className={status.warning ? "library-folder__status--warning" : undefined}
                        aria-live="polite"
                      >
                        {status.text}
                      </td>
                      <td className="settings-table__actions">
                        <TooltipButton
                          label="Remove"
                          aria-label={`Remove read-only folder ${folder.path}`}
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => setRemoving(folder.path)}
                        >
                          <Trash2 aria-hidden="true" />
                        </TooltipButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <SettingsRow
          label="Add a folder"
          htmlFor="library-read-only-folder"
          help={addError || OUTSIDE_DOWNLOADS}
          tone={addError ? "warning" : "default"}
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
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!draft || adding}
            onClick={add}
          >
            {adding ? <DotLoader size="xs" label={null} /> : null}
            Add
          </button>
        </SettingsRow>
      </SettingsGroup>
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
    </>
  );
}

function ImportGroup({
  busy,
  operation,
  onChanged,
}: {
  busy: boolean;
  operation: FileOperation | null;
  onChanged: () => Promise<void>;
}) {
  const { showError } = useServerSettings();
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
        if (requestId !== requestRef.current) return;
        setCheck({
          loading: false,
          result: null,
          error: errorMessage(error, "Aurral could not check this folder."),
        });
      });
  }, [sourcePath]);

  const result = check.result;
  const hardlinkUnavailable = Boolean(result && !result.hardlink?.available);
  const folderHelp = check.loading
    ? "Checking the folder…"
    : check.error ||
      (result ? `${countLabel(result.audioFiles, "music file")} found.` : OUTSIDE_DOWNLOADS);

  const start = async () => {
    if (!result) return;
    setStarting(true);
    try {
      await parseResponse(
        libraryFilesClient.files.ingest.$post({
          json: { sourcePath: result.sourcePath, mode, monitor, fillTags },
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
    <SettingsGroup
      title="Import a folder"
      note="Imports music into the Downloads Folder with Aurral naming. Existing files are never overwritten. To leave a folder unchanged, add it as a read-only folder instead."
    >
      <SettingsRow
        label="Folder"
        htmlFor="library-ingest-source"
        help={folderHelp}
        tone={check.error ? "warning" : "default"}
      >
        <DownloadFolderField
          id="library-ingest-source"
          value={sourcePath}
          suggestFolder={false}
          createOnConfirm={false}
          onChange={setSourcePath}
        />
      </SettingsRow>
      <SettingsRow
        label="Mode"
        htmlFor="library-ingest-mode"
        help={
          mode === "copy" && result && hardlinkUnavailable
            ? `${MODE_HELP.copy} Hardlink is not available: ${result.hardlink.reason}`
            : MODE_HELP[mode]
        }
      >
        <Select
          id="library-ingest-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "move", label: "Move" },
            { value: "copy", label: "Copy" },
            { value: "hardlink", label: "Hardlink", disabled: hardlinkUnavailable },
          ]}
        />
      </SettingsRow>
      <SettingsRow
        label="Fill in missing tags"
        htmlFor="library-ingest-fill-tags"
        help="Fills missing MusicBrainz tags. Existing tags stay."
      >
        <PillToggle
          id="library-ingest-fill-tags"
          checked={fillTags}
          aria-label="Fill in missing tags"
          onChange={(event) => setFillTags(event.target.checked)}
        />
      </SettingsRow>
      <SettingsRow label="Monitor" htmlFor="library-ingest-monitor" help={MONITOR_HELP[monitor]}>
        <Select
          id="library-ingest-monitor"
          value={monitor}
          onChange={setMonitor}
          options={[
            { value: "none", label: "None" },
            { value: "tracks", label: "Tracks" },
            { value: "albums", label: "Albums" },
          ]}
        />
      </SettingsRow>
      {result?.readOnlyFolder ? (
        <SettingsNote tone="warning">
          {result.readOnlyFolder} is a read-only folder. Moving files takes them out of it. Copy and
          Hardlink keep its files.
        </SettingsNote>
      ) : null}
      {result?.lidarrRoot ? (
        <SettingsNote tone="warning">
          Lidarr uses {result.lidarrRoot}. Moving files breaks its library. Copy and Hardlink keep
          its files.
        </SettingsNote>
      ) : null}
      <SettingsActions>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!result?.audioFiles || busy || starting}
          onClick={start}
        >
          {starting ? <DotLoader size="xs" label={null} /> : null}
          Import folder
        </button>
      </SettingsActions>
      <LibraryFileOperation operation={operation} onChanged={onChanged} showError={showError} />
    </SettingsGroup>
  );
}

function CleanUpGroup({
  busy,
  operation,
  onChanged,
}: {
  busy: boolean;
  operation: FileOperation | null;
  onChanged: () => Promise<void>;
}) {
  const { showError } = useServerSettings();
  const [starting, setStarting] = useState(false);

  const cleanUp = async () => {
    setStarting(true);
    try {
      await parseResponse(libraryFilesClient.files.cleanup.$post());
      await onChanged();
    } catch (error) {
      showError(errorMessage(error, "Clean up could not start. Nothing was changed."));
    } finally {
      setStarting(false);
    }
  };

  return (
    <SettingsGroup
      title="Clean up Library"
      note="Organizes files in the Downloads Folder and fills missing tags. Playlists, favorites, and media servers follow the files. Lidarr files stay untouched. When names clash, Aurral keeps the better copy and offers to delete the other."
    >
      <SettingsActions>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || starting}
          onClick={cleanUp}
        >
          {starting ? <DotLoader size="xs" label={null} /> : null}
          Clean up Library
        </button>
      </SettingsActions>
      <LibraryFileOperation operation={operation} onChanged={onChanged} showError={showError} />
    </SettingsGroup>
  );
}

export function LibrarySection() {
  const files = useLibraryFiles();
  const operationQuery = useLibraryFileOperation(files.data?.operation?.id ?? null);
  const operation = operationQuery.data || files.data?.operation || null;
  const busy = Boolean(operation && ACTIVE_LIBRARY_FILE_STATUSES.has(operation.status));

  const refresh = async () => {
    await refreshLibraryFiles();
  };

  return (
    <SettingsPage title="Library">
      <DownloadsFolderGroup />
      <ReadOnlyFoldersGroup onChanged={refresh} />
      <ImportGroup
        busy={busy}
        operation={operation?.kind === "ingest" ? operation : null}
        onChanged={refresh}
      />
      <CleanUpGroup
        busy={busy}
        operation={operation?.kind === "cleanup" ? operation : null}
        onChanged={refresh}
      />
      {files.isError ? (
        <SettingsGroup>
          <SettingsNote tone="warning">
            Couldn&apos;t load Library file operations.{" "}
            <button type="button" className="settings-link" onClick={() => files.refetch()}>
              Try again
            </button>
          </SettingsNote>
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
