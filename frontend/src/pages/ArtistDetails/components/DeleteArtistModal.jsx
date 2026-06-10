import { Loader } from "lucide-react";
import PropTypes from "prop-types";

export function DeleteArtistModal({
  show,
  artistName,
  libraryArtistName,
  deleteFiles,
  onDeleteFilesChange,
  onCancel,
  onConfirm,
  deleting,
}) {
  if (!show) return null;
  return (
    <div className="artist-modal-backdrop">
      <div className="artist-modal">
        <h3 className="artist-modal__title">
          Remove Artist from Library
        </h3>
        <p className="artist-modal__copy">
          Are you sure you want to remove{" "}
          <strong>
            {artistName || libraryArtistName}
          </strong>{" "}
          from library?
        </p>

        <div>
          <label className="artist-checkbox-label">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => onDeleteFilesChange(e.target.checked)}
              className="artist-checkbox"
            />
            <div>
              <span className="artist-card-title">
                Delete artist folder and files
              </span>
              <p className="artist-modal__subcopy">
                This will permanently delete the artist&apos;s folder and all
                music files from your disk. This action cannot be undone.
              </p>
            </div>
          </label>
        </div>

        <div className="artist-modal__actions">
          <button
            onClick={onCancel}
            disabled={deleting}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="btn btn-danger"
          >
            {deleting ? (
              <>
                <Loader className="artist-icon-sm animate-spin" />
                Removing...
              </>
            ) : (
              "Remove Artist"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

DeleteArtistModal.propTypes = {
  show: PropTypes.bool,
  artistName: PropTypes.string,
  libraryArtistName: PropTypes.string,
  deleteFiles: PropTypes.bool,
  onDeleteFilesChange: PropTypes.func,
  onCancel: PropTypes.func,
  onConfirm: PropTypes.func,
  deleting: PropTypes.bool,
};
