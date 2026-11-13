import { useEffect, useRef, useState, type ComponentProps } from "react";
import { parseResponse, type InferResponseType } from "hono/client";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "../../../components/icons";
import { ConfirmModal } from "../../../components/ConfirmModal";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { DotLoader } from "../../../components/DotLoader";
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
import { settingsClient } from "../../../utils/api/clients/settings.ts";
import { queryKeys } from "../../../queryClient.ts";
import LibraryFileOperation from "../components/LibraryFileOperation";
import { Select } from "../../../components/Select";
import { useServerSettings } from "../SettingsProviders";
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from "../SettingsLayout";
import "./library.css";
import { readApiError } from "../../../utils/api/errors.ts";

type FileOperation = ComponentProps<typeof LibraryFileOperation>["operation"];
type ReadOnlyFolder = InferResponseType<
  (typeof libraryFilesClient.files)["read-only-folders"]["$get"],
  200
>["folders"][number];

const MODE_HELP = {
  move: "Moves files to the Library folder and removes empty source folders.",
  keep: "Source files stay. Aurral hardlinks them when it can, which uses no extra space, and copies them otherwise.",
};

const MONITOR_HELP = {
  none: "No automatic upgrades. Enable monitoring later in Library.",
  tracks: "Upgrades imported tracks to the quality cutoff when Automatic upgrades is enabled.",
  albums: "Upgrades imported tracks and downloads missing album tracks.",
};

const OUTSIDE_LIBRARY_FOLDER = "Choose a folder outside the Library folder.";

const errorMessage = (error: unknown, fallback: string) => {
  const failure = readApiError(error);
  return failure.message || failure.text || fallback;
};

const countLabel = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

function folderStatus(folder: ReadOnlyFolder, scanning: boolean) {
  if (!folder.readable) return { text: "Aurral cannot read this folder.", warning: true };
  if (scanning && folder.tracks === 0) return { text: "Scanning…" };
  const tracks = countLabel(folder.tracks, "track");
  return { text: folder.insideLibraryFolder ? `${tracks}, inside the Library folder` : tracks };
}

function LibraryFolderGroup() {
  const { settings, updateSettings } = useServerSettings();
  return (
    <SettingsGroup title="Library folder">
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

function PlaylistFilesGroup() {
  const query = useQuery({
    queryKey: queryKeys.playlistFileSettings,
    queryFn: ({ signal }) =>
      parseResponse(settingsClient["playlist-files"].$get({}, { init: { signal } })),
  });
  if (query.isError) {
    return (
      <SettingsGroup title="Playlist files">
        <SettingsNote tone="warning">Couldn&apos;t load playlist files.</SettingsNote>
      </SettingsGroup>
    );
  }
  if (!query.data) return null;
  return (
    <SettingsGroup
      title="Playlist files"
      note="M3U files for every flow and playlist. Media servers that scan this folder pick them up."
    >
      <SettingsRow label="Folder">
        <span className="settings-row__value">{query.data.folder}</span>
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
  const handover = folders.some((folder) => folder.path === removing && folder.insideLibraryFolder);

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
          help={addError || OUTSIDE_LIBRARY_FOLDER}
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
        title={handover ? "Let Aurral manage this folder?" : "Remove this read-only folder?"}
        body={
          handover
            ? `The music in ${removing} becomes part of the Library folder. Aurral can replace and delete these files like any Library file. Nothing leaves the Library or downloads again.`
            : `The music in ${removing} leaves the Library. The files stay on disk. Playlist and flow tracks that use them download again.`
        }
        confirmLabel={handover ? "Manage folder" : "Remove folder"}
        tone={handover ? "primary" : "danger"}
        busyLabel={handover ? "Saving…" : "Removing…"}
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
  const [mode, setMode] = useState<keyof typeof MODE_HELP>("keep");
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
  const folderHelp = check.loading
    ? "Checking the folder…"
    : check.error ||
      (result ? `${countLabel(result.audioFiles, "music file")} found.` : OUTSIDE_LIBRARY_FOLDER);

  const start = async () => {
    if (!result) return;
    setStarting(true);
    try {
      await parseResponse(
        libraryFilesClient.files.ingest.$post({
          json: {
            sourcePath: result.sourcePath,
            mode: mode === "move" ? "move" : result.hardlink?.available ? "hardlink" : "copy",
            monitor,
            fillTags,
          },
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
      note="Imports music into the Library folder with Aurral naming. Existing files are never overwritten. To leave a folder unchanged, add it as a read-only folder instead."
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
      <SettingsRow label="Mode" htmlFor="library-ingest-mode" help={MODE_HELP[mode]}>
        <Select
          id="library-ingest-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "keep", label: "Keep originals" },
            { value: "move", label: "Move" },
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
          {result.readOnlyFolder} is a read-only folder. Moving files takes them out of it. Keep
          originals leaves its files.
        </SettingsNote>
      ) : null}
      <LibraryFileOperation
        operation={operation}
        onChanged={onChanged}
        showError={showError}
        action={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!result?.audioFiles || busy || starting}
            onClick={start}
          >
            {starting ? <DotLoader size="xs" label={null} /> : null}
            Import folder
          </button>
        }
      />
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
      note="Renames Library files to Aurral's naming and fills missing tags. Read-only folders stay untouched. Duplicates are removed only when you ask."
    >
      <LibraryFileOperation
        operation={operation}
        onChanged={onChanged}
        showError={showError}
        action={
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || starting}
            onClick={cleanUp}
          >
            {starting ? <DotLoader size="xs" label={null} /> : null}
            Clean up Library
          </button>
        }
      />
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
      <LibraryFolderGroup />
      <PlaylistFilesGroup />
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
