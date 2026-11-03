import { useState } from "react";
import { createPortal } from "react-dom";
import { parseResponse } from "hono/client";
import { Plus } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import { useToast } from "../../contexts/ToastContext";
import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { flowsClient } from "../../utils/api/clients/flows.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
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
import { PlaylistEditModal } from "./PlaylistEditModal.tsx";
import { formatTrackTotal, usePlaylistTracks } from "./playlistPageUtils.ts";
import { usePlaylistStatus } from "./usePlaylistStatus.ts";

const flowParam = (flowId: string) => ({ flowId: encodeURIComponent(flowId) });

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
  const [busy, setBusy] = useState<"save" | "create" | "download" | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDownloadSaved, setConfirmDownloadSaved] = useState(false);
  const { tracks, refresh } = usePlaylistTracks(selection.id);

  const flow = flows.find((entry) => entry.id === selection.id) ?? null;
  const { draft } = selection;
  const dirty = flow !== null && isFlowDirty(flow, draft);
  const savedCount = tracks.filter((track) => track.status === "saved").length;

  const open = (id: string, nextDraft: FlowDraft) => {
    setSelection({ id, draft: nextDraft });
    setError("");
    setView("pane");
  };
  const leave = (next: () => void) => (dirty ? setPendingLeave(() => next) : next());
  const close = () => leave(onClose);

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

  const save = async () => {
    if (!flow) return;
    setBusy("save");
    setError("");
    try {
      const { flow: saved } = await parseResponse(
        flowsClient.flows[":flowId"].$put({
          param: flowParam(flow.id),
          json: {
            ...buildFlowFromForm(draft),
            autoDownload: draft.autoDownload !== false,
            showInLibrary: draft.showInLibrary === true,
          },
        }),
      );
      setSelection({ id: flow.id, draft: flowToForm(saved) });
      showSuccess(`Saved ${flow.name}`);
      await fetchStatus();
      if (flow.autoDownload === false && saved.autoDownload !== false && savedCount > 0) {
        setConfirmDownloadSaved(true);
      }
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to save flow"));
    } finally {
      setBusy(null);
    }
  };

  const downloadSaved = async () => {
    if (!flow) return;
    setBusy("download");
    try {
      await parseResponse(
        flowsClient.flows[":flowId"].download.$post({ param: flowParam(flow.id) }),
      );
      showSuccess(`Downloading ${formatTrackTotal(savedCount)}`);
      await fetchStatus();
      await refresh();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to download flow tracks"));
    } finally {
      setBusy(null);
      setConfirmDownloadSaved(false);
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
        closeDisabled={busy === "save"}
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
                  disabled={busy === "save"}
                >
                  <PlaylistArtworkThumb
                    artworkUrl={artworkUrlFor(entry.id)}
                    name={entry.name}
                    className="flow-editor__rail-art"
                  />
                  <span className="flow-editor__rail-name">{entry.name}</span>
                  {active && dirty ? (
                    <span className="flow-editor__dirty">
                      <span className="sr-only">Unsaved changes</span>
                    </span>
                  ) : null}
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
            closeDisabled={busy === "save"}
            status={
              busy === "save" ? (
                <>
                  <DotLoader size="xs" label={null} /> Saving…
                </>
              ) : dirty ? (
                "Unsaved"
              ) : null
            }
            actions={
              dirty ? (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy === "save"}
                    onClick={() => open(flow.id, flowToForm(flow))}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy === "save"}
                    onClick={save}
                  >
                    Save
                  </button>
                </>
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
            body={`Your changes to ${flow?.name ?? "this flow"} are not saved.`}
            confirmLabel="Discard"
            busyLabel="Discarding"
            onCancel={() => setPendingLeave(null)}
            onConfirm={() => {
              pendingLeave?.();
              setPendingLeave(null);
            }}
          />
          <ConfirmModal
            open={confirmDownloadSaved}
            title={`Download ${formatTrackTotal(savedCount)} already in this flow?`}
            body="New tracks will download automatically from now on."
            confirmLabel="Download now"
            cancelLabel="Not now"
            tone="primary"
            busyLabel="Downloading"
            busy={busy === "download"}
            onCancel={() => setConfirmDownloadSaved(false)}
            onConfirm={downloadSaved}
          />
        </>,
        document.body,
      )}
    </>
  );
}
