import { useState } from "react";
import { Link } from "react-router";
import { FolderSync } from "lucide-react";
import { ModalShell } from "./PlaylistModals";
import { DotLoader } from "./DotLoader";
import LibraryFileOperation, { LibraryFileOperationActions } from "./LibraryFileOperation";
import { refreshLibraryFiles, useLibraryFileOperation } from "../hooks/useLibraryFileOperation.js";
import { startLibraryOrganize } from "../utils/api/endpoints/library.js";

const ACTION_NAMES = { rename: "rename files", retag: "write tags", upgrade: "search for upgrades" };

const listActions = (actions) => {
  const names = actions.map((action) => ACTION_NAMES[action]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "";
};

export default function OrganizeFilesModal({ target, actions = [], onClose, onFinished, showError }) {
  const [operationId, setOperationId] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const operationQuery = useLibraryFileOperation(operationId);
  const operation = operationQuery.data || null;
  const finished = ["complete", "cancelled", "failed"].includes(operation?.status);

  const preview = async () => {
    setStarting(true);
    setError("");
    try {
      const result = await startLibraryOrganize({ kind: target.kind, id: target.id }, actions);
      setOperationId(result.operation.id);
      void refreshLibraryFiles();
    } catch (requestError) {
      setError(
        requestError.response?.status === 409
          ? "Another library file operation is in progress. Finish or cancel it in Settings > Library files first."
          : requestError.response?.data?.message || requestError.message || "Organize could not start. Nothing was changed.",
      );
    } finally {
      setStarting(false);
    }
  };

  const close = () => {
    if (finished) onFinished?.();
    onClose();
  };

  return (
    <ModalShell
      open={Boolean(target)}
      title={`Organize ${target?.name || target?.kind || "files"}`}
      description={operation
        ? "A preview keeps running if you close this window. Follow it in Settings > Library files."
        : `Preview how Aurral would ${listActions(actions)} for this ${target?.kind}. Nothing changes until you apply it.`}
      onClose={close}
      disableClose={starting}
      footer={
        <>
          {operation ? (
            <LibraryFileOperationActions
              operation={operation}
              onChanged={() => operationQuery.refetch()}
              showError={showError}
              buttonClassName="btn btn-secondary btn-sm"
              primaryClassName="btn btn-primary btn-sm"
            />
          ) : (
            <button type="button" className="btn btn-primary btn-sm" disabled={starting || !actions.length} onClick={preview}>
              {starting ? <DotLoader size="sm" label={null} /> : <FolderSync className="artist-icon-sm" aria-hidden />}
              Preview changes
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" disabled={starting} onClick={close}>
            {finished ? "Done" : "Close"}
          </button>
        </>
      }
      className="organize-files-modal"
    >
      {operation ? <LibraryFileOperation operation={operation} /> : null}
      {error ? (
        <p className="artist-error-text" role="alert">
          {error} <Link to="/settings/library-files" onClick={onClose}>Open Library files</Link>
        </p>
      ) : null}
    </ModalShell>
  );
}
