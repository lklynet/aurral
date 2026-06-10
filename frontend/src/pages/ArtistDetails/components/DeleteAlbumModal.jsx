import { Loader } from "lucide-react";
import PropTypes from "prop-types";

export function DeleteAlbumModal({
  show,
  title,
  deleteFiles,
  onDeleteFilesChange,
  onCancel,
  onConfirm,
  removing,
}) {
  if (!show) return null;
  return (
    <div className="artist-modal-backdrop">
      <div className="artist-modal">
        <h3 className="artist-modal__title">
          Delete Album from Library
        </h3>
        <p className="artist-modal__copy">
          Are you sure you want to delete{" "}
          <strong>{title}</strong> from library?
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
                Delete album folder and files
              </span>
              <p className="artist-modal__subcopy">
                This will permanently delete the album&apos;s folder and all
                music files from your disk. This action cannot be undone.
              </p>
            </div>
          </label>
        </div>

        <div className="artist-modal__actions">
          <button
            onClick={onCancel}
            disabled={!!removing}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!!removing}
            className="btn btn-danger"
          >
            {removing ? (
              <>
                <Loader className="artist-icon-sm animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete Album"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

DeleteAlbumModal.propTypes = {
  show: PropTypes.bool,
  title: PropTypes.string,
  deleteFiles: PropTypes.bool,
  onDeleteFilesChange: PropTypes.func,
  onCancel: PropTypes.func,
  onConfirm: PropTypes.func,
  removing: PropTypes.bool,
};
