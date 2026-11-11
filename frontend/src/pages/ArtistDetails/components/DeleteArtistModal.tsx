import { useId, useRef } from "react";
import { DotLoader } from "../../../components/DotLoader";
import { useModalDialog } from "../../../hooks/useModalDialog.ts";

interface DeleteArtistModalProps {
  show: boolean;
  artistName?: string | null;
  libraryArtistName?: string | null;
  sources?: string[];
  deleteFiles: boolean;
  onDeleteFilesChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  deleting?: boolean;
}

export function DeleteArtistModal({
  show,
  artistName,
  libraryArtistName,
  sources = [],
  deleteFiles,
  onDeleteFilesChange,
  onCancel,
  onConfirm,
  deleting,
}: DeleteArtistModalProps) {
  const titleId = useId();
  const cancelRef = useRef(null);
  const { dialogRef } = useModalDialog({
    open: show,
    onClose: onCancel,
    closeDisabled: deleting,
    initialFocusRef: cancelRef,
  });

  if (!show) return null;
  const name = artistName || libraryArtistName;
  const hasLibraryFolderFiles = sources.includes("aurral");
  const readOnlyOnly = !hasLibraryFolderFiles && sources.includes("readonly");
  return (
    <div className="artist-modal-backdrop">
      <div
        ref={dialogRef}
        className="artist-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="artist-modal__title">
          Delete artist
        </h3>
        {readOnlyOnly ? (
          <p className="artist-modal__copy">
            Aurral stops monitoring <strong>{name}</strong> and drops its wanted albums. Its music
            in read-only folders stays in the Library.
          </p>
        ) : (
          <p className="artist-modal__copy">
            Delete <strong>{name}</strong> and its albums from your library?
          </p>
        )}

        {hasLibraryFolderFiles ? (
          <label className="artist-checkbox-label">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => onDeleteFilesChange(e.target.checked)}
              className="artist-checkbox"
            />
            <div>
              <span className="artist-card-title">Delete artist files</span>
              <p className="artist-modal__subcopy">
                Permanently deletes the artist files from disk.
              </p>
            </div>
          </label>
        ) : null}

        <div className="artist-modal__actions">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={deleting}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button onClick={onConfirm} disabled={deleting} className="btn btn-danger">
            {deleting ? (
              <>
                <DotLoader size="sm" label={null} />
                Deleting...
              </>
            ) : (
              "Delete artist"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
