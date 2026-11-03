import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseResponse } from "hono/client";
import { Plus } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import { useToast } from "../../contexts/ToastContext";
import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import { afterTextEntry } from "../../utils/afterTextEntry.ts";
import { queryClient, queryKeys } from "../../queryClient.ts";
import {
  SettingsGroup,
  SettingsNote,
  SettingsPane,
  SettingsShell,
} from "../Settings/SettingsLayout.tsx";
import { FlowFormFields } from "./components/flowFormComponents.tsx";
import { PlaylistArtworkThumb } from "./components/PlaylistArtworkThumb.tsx";
import { buildFlowFromForm, flowToForm, isFlowDirty, newBlankFlow } from "./flowPageUtils.ts";
import type { FlowDraft } from "./flowPageUtils.ts";
import type { Flow } from "./playlistStats.ts";
import { PlaylistEditModal } from "./PlaylistEditModal.tsx";
import { formatTrackTotal, usePlaylistTracks } from "./playlistPageUtils.ts";
import { usePlaylistStatus } from "./usePlaylistStatus.ts";

const flowParam = (flowId: string) => ({ flowId: encodeURIComponent(flowId) });

type SaveJob = { flow: Flow; draft: FlowDraft; savedCount: number };

export default function FlowEditor({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const { showSuccess, showError } = useToast();
  const { flows, fetchStatus } = usePlaylistStatus();
  const { artworkUrlFor } = usePlaylistArtwork();
  const [selection, setSelection] = useState<{ id: string; draft: FlowDraft }>(() => ({
    id: flowId,
    draft: flowToForm(flows.find((entry) => entry.id === flowId)),
  }));
  const [view, setView] = useState<"nav" | "pane">("pane");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"create" | "download" | null>(null);
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

  const rename = async (name: string) => {
    if (!flow) return;
    await parseResponse(
      flowsClient.flows[":flowId"].$put({ param: flowParam(flow.id), json: { name } }),
    );
    setSelection((current) => ({ ...current, draft: { ...current.draft, name } }));
    await fetchStatus();
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
            <SettingsGroup>
              <div className="flow-editor__identity">
                <PlaylistArtworkThumb
                  artworkUrl={artworkUrlFor(flow.id)}
                  name={flow.name}
                  className="flow-editor__cover"
                />
                <span className="flow-editor__name">{flow.name}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setEditOpen(true)}
                >
                  Name and cover
                </button>
              </div>
            </SettingsGroup>
            <FlowFormFields
              draft={draft}
              onDraftChange={(updater) => {
                setSelection((current) => ({ ...current, draft: updater(current.draft) }));
                setError("");
              }}
            />
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
      {createPortal(
        <>
          {editOpen && flow ? (
            <PlaylistEditModal
              entry={flow}
              title="Name and cover"
              onClose={() => setEditOpen(false)}
              onRename={rename}
            />
          ) : null}
          <ConfirmModal
            open={pendingLeave !== null}
            title="Discard unsaved changes?"
            body={leaveError}
            confirmLabel="Discard"
            busyLabel="Discarding"
            onCancel={() => setPendingLeave(null)}
            onConfirm={() => {
              pendingLeave?.();
              setPendingLeave(null);
            }}
          />
          <ConfirmModal
            open={pendingDownload !== null}
            title={`Download ${formatTrackTotal(pendingDownload?.count ?? 0)} already in ${pendingDownload?.name ?? "this flow"}?`}
            body="New tracks will download automatically from now on."
            confirmLabel="Download now"
            cancelLabel="Not now"
            tone="primary"
            busyLabel="Downloading"
            busy={busy === "download"}
            onCancel={() => setPendingDownload(null)}
            onConfirm={downloadSaved}
          />
        </>,
        document.body,
      )}
    </>
  );
}
