import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { parseResponse } from "hono/client";
import { Plus, Trash2 } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import { useToast } from "../../contexts/ToastContext";
import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import { afterTextEntry } from "../../utils/afterTextEntry.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import { SettingsNote, SettingsPane, SettingsShell } from "../Settings/SettingsLayout.tsx";
import { FlowFormFields } from "./components/flowFormComponents.tsx";
import { PlaylistArtworkThumb } from "../../components/PlaylistArtworkThumb.tsx";
import {
  buildFlowFromForm,
  describeFlowRecipe,
  draftRecipe,
  flowToForm,
  isFlowDirty,
  newBlankFlow,
} from "./flowPageUtils.ts";
import { FlowEnabledSwitch } from "./FlowEnabledSwitch.tsx";
import type { FlowDraft } from "./flowPageUtils.ts";
import type { Flow } from "../../utils/playlistStats.ts";
import { PlaylistEditModal } from "./PlaylistEditModal.tsx";
import { formatTrackTotal, usePlaylistTracks } from "./playlistPageUtils.ts";
import { usePlaylistStatus } from "./usePlaylistStatus.ts";

const flowParam = (flowId: string) => ({ flowId: encodeURIComponent(flowId) });

type SaveJob = { flow: Flow; draft: FlowDraft; savedCount: number };

export default function FlowEditor({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const { flows, fetchStatus } = usePlaylistStatus();
  const { artworkUrlFor } = usePlaylistArtwork();
  const [selection, setSelection] = useState<{ id: string; draft: FlowDraft }>(() => ({
    id: flowId,
    draft: flowToForm(flows.find((entry) => entry.id === flowId)),
  }));
  const [view, setView] = useState<"nav" | "pane">("pane");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"create" | "download" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const queuedRef = useRef(new Map<string, SaveJob>());
  const selectedIdRef = useRef(selection.id);
  const saveRef = useRef(() => {});
  const flush = useCallback(() => saveRef.current(), []);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [pendingDownload, setPendingDownload] = useState<{
    id: string;
    name: string;
    count: number;
  } | null>(null);
  const { tracks } = usePlaylistTracks(selection.id);

  const flow = flows.find((entry) => entry.id === selection.id) ?? null;
  const { draft } = selection;
  const dirty = flow !== null && isFlowDirty(flow, draft);
  const savedCount = tracks.filter((track) => track.status === "saved").length;

  const open = (id: string, nextDraft: FlowDraft) => {
    setSelection({ id, draft: nextDraft });
    setError("");
    setView("pane");
  };
  const draftError = (() => {
    try {
      buildFlowFromForm(draft);
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : "This flow can't be saved.";
    }
  })();
  const leaveError = draftError || (dirty ? error : "");
  const blocked = leaveError !== "";
  const leave = (next: () => void) => (blocked ? setPendingLeave(() => next) : next());
  const close = () =>
    blocked
      ? setPendingLeave(() => () => {
          saveRef.current = () => {};
          onClose();
        })
      : onClose();

  const select = (id: string) => {
    if (id === selection.id) return setView("pane");
    leave(() => open(id, flowToForm(flows.find((entry) => entry.id === id))));
  };

  const create = () =>
    leave(async () => {
      setBusy("create");
      try {
        const { flow: created } = await parseResponse(
          flowsClient.flows.$post({ json: newBlankFlow(flows) }),
        );
        await fetchStatus();
        open(created.id, flowToForm(created));
        showSuccess(`Created ${created.name}`);
      } catch (err) {
        showError(getApiErrorMessage(err, "Failed to create flow"));
      } finally {
        setBusy(null);
      }
    });

  const runSave = async (job: SaveJob) => {
    if (savingRef.current) {
      queuedRef.current.set(job.flow.id, job);
      return;
    }
    const { flow: target, draft: submitted, savedCount: count } = job;
    savingRef.current = true;
    setSaving(true);
    try {
      const { flow: saved } = await parseResponse(
        flowsClient.flows[":flowId"].$put({
          param: flowParam(target.id),
          json: {
            ...buildFlowFromForm(submitted),
            autoDownload: submitted.autoDownload !== false,
            showInLibrary: submitted.showInLibrary === true,
          },
        }),
      );
      setSelection((current) =>
        current.draft === submitted ? { id: target.id, draft: flowToForm(saved) } : current,
      );
      if (selectedIdRef.current === target.id) setError("");
      await fetchStatus();
      if (target.autoDownload === false && saved.autoDownload !== false && count > 0) {
        setPendingDownload({ id: target.id, name: target.name, count });
      }
    } catch (err) {
      const message = getApiErrorMessage(err, `Failed to save ${target.name}`);
      if (selectedIdRef.current === target.id) setError(message);
      else showError(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
      const [next] = queuedRef.current.values();
      if (next) {
        queuedRef.current.delete(next.flow.id);
        void runSave(next);
      }
    }
  };

  useEffect(() => {
    selectedIdRef.current = selection.id;
    saveRef.current = () => {
      if (flow && isFlowDirty(flow, draft)) void runSave({ flow, draft, savedCount });
    };
  });
  useEffect(() => afterTextEntry(flush), [draft, flush]);
  useEffect(() => flush, [flush]);

  const downloadSaved = async () => {
    if (!pendingDownload) return;
    const { id, count } = pendingDownload;
    setBusy("download");
    try {
      await parseResponse(flowsClient.flows[":flowId"].download.$post({ param: flowParam(id) }));
      showSuccess(`Downloading ${formatTrackTotal(count)}`);
      await fetchStatus();
      await queryClient.invalidateQueries({ queryKey: queryKeys.playlistJobs(id) });
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to download flow tracks"));
    } finally {
      setBusy(null);
      setPendingDownload(null);
    }
  };

  const deleteFlow = async () => {
    if (!flow) return;
    setBusy("delete");
    try {
      const result = await parseResponse(
        flowsClient.flows[":flowId"].$delete({ param: flowParam(flow.id) }),
      );
      saveRef.current = () => {};
      showSuccess(result?.queued ? `Removal of ${flow.name} queued` : `Deleted ${flow.name}`);
      await fetchStatus();
      onClose();
      navigate("/flows", { replace: true });
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to delete flow"));
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <SettingsShell
        label="Flows"
        view={view}
        onClose={close}
        nav={
          <nav className="settings-dialog__group" aria-label="Flows">
            {flows.map((entry) => {
              const active = entry.id === selection.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`settings-dialog__link${active ? " is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => select(entry.id)}
                >
                  <PlaylistArtworkThumb
                    sizes="1.25rem"
                    artworkUrl={artworkUrlFor(entry.id)}
                    name={entry.name}
                    className="flow-editor__rail-art"
                  />
                  <span className="flow-editor__rail-name">{entry.name}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="settings-dialog__link"
              onClick={create}
              disabled={busy === "create"}
            >
              {busy === "create" ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <Plus aria-hidden="true" />
              )}
              <span>New flow</span>
            </button>
          </nav>
        }
      >
        {flow ? (
          <SettingsPane
            crumbs={[{ label: "Flows" }]}
            title={flow.name}
            backLabel="Back to flows"
            onBack={() => setView("nav")}
            closeLabel="Close flows"
            onClose={close}
            status={
              saving ? (
                <>
                  <DotLoader size="xs" label={null} /> Saving…
                </>
              ) : error ? (
                "Not saved"
              ) : null
            }
          >
            {error ? <SettingsNote tone="error">{error}</SettingsNote> : null}
            <div>
              <div className="flow-editor__identity">
                <PlaylistArtworkThumb
                  sizes="4rem"
                  artworkUrl={artworkUrlFor(flow.id)}
                  name={flow.name}
                  className="flow-editor__cover"
                  onClick={() => setEditOpen(true)}
                />
                <input
                  type="text"
                  className="input flow-editor__name"
                  aria-label="Flow name"
                  value={draft.name ?? ""}
                  onChange={(event) => {
                    const name = event.target.value;
                    setSelection((current) => ({ ...current, draft: { ...current.draft, name } }));
                    setError("");
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setEditOpen(true)}
                >
                  Change cover
                </button>
              </div>
              <p className="flow-editor__recipe">{describeFlowRecipe(draftRecipe(draft))}</p>
            </div>
            <FlowFormFields
              draft={draft}
              enabled={flow.enabled === true}
              enabledSwitch={
                <FlowEnabledSwitch flow={flow} trackCount={tracks.length} onChanged={fetchStatus} />
              }
              onDraftChange={(updater) => {
                setSelection((current) => ({ ...current, draft: updater(current.draft) }));
                setError("");
              }}
            />
            <div className="flow-editor__footer">
              <button
                type="button"
                className="btn btn-ghost-danger btn-sm"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 aria-hidden="true" />
                Delete flow
              </button>
            </div>
          </SettingsPane>
        ) : (
          <SettingsPane
            crumbs={[{ label: "Flows" }]}
            title="Flow not found"
            backLabel="Back to flows"
            onBack={() => setView("nav")}
            closeLabel="Close flows"
            onClose={onClose}
          >
            <SettingsNote>It may have been deleted.</SettingsNote>
          </SettingsPane>
        )}
      </SettingsShell>
      {editOpen && flow ? (
        <PlaylistEditModal entry={flow} title="Change cover" onClose={() => setEditOpen(false)} />
      ) : null}
      <ConfirmModal
        open={pendingLeave !== null}
        title={`Discard changes to ${flow?.name ?? "this flow"}?`}
        body={leaveError}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        busyLabel="Discarding"
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => {
          pendingLeave?.();
          setPendingLeave(null);
        }}
      />
      <ConfirmModal
        open={confirmDelete}
        title={`Delete ${flow?.name ?? "this flow"}?`}
        body="Removes this flow, its tracks, and its schedule."
        confirmLabel="Delete flow"
        busyLabel="Deleting…"
        busy={busy === "delete"}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={deleteFlow}
      />
      <ConfirmModal
        open={pendingDownload !== null}
        title={`Download the ${formatTrackTotal(pendingDownload?.count ?? 0)} already here?`}
        body="New tracks download automatically from now on."
        confirmLabel={`Download ${formatTrackTotal(pendingDownload?.count ?? 0)}`}
        cancelLabel="Not now"
        tone="primary"
        busyLabel="Downloading"
        busy={busy === "download"}
        onCancel={() => setPendingDownload(null)}
        onConfirm={downloadSaved}
      />
    </>
  );
}
