import PropTypes from "prop-types";
import { Loader } from "lucide-react";

export function AddArtistCustomizeModal({
  show,
  artistName,
  loading,
  preferences,
  rootFolderPath,
  setRootFolderPath,
  qualityProfileId,
  setQualityProfileId,
  tagId,
  setTagId,
  onClose,
  onConfirm,
  confirming,
}) {
  if (!show) return null;

  const rootFolders = Array.isArray(preferences?.rootFolders)
    ? preferences.rootFolders
    : [];
  const qualityProfiles = Array.isArray(preferences?.qualityProfiles)
    ? preferences.qualityProfiles
    : [];
  const tags = Array.isArray(preferences?.tags) ? preferences.tags : [];
  const configured = preferences?.configured === true;

  return (
    <div
      className="artist-modal-backdrop"
      onClick={confirming ? undefined : onClose}
    >
      <div
        className="artist-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="artist-modal__header">
          <h3 className="artist-modal__title">
            Customize Add
          </h3>
        </div>
        <p className="artist-modal__subcopy">
            Choose where <strong>{artistName}</strong> should go for this add
            only.
        </p>

        {loading ? (
          <div className="artist-loading">
            <Loader
              className="artist-spinner animate-spin"
            />
          </div>
        ) : (
          <div className="artist-modal__fields">
            <div>
              <label className="artist-field-label">
                Root Folder
              </label>
              <div className="artist-modal-field aurral-radius-round">
                <select
                  className="artist-modal-select"
                  value={rootFolderPath}
                  onChange={(e) => setRootFolderPath(e.target.value)}
                  disabled={!configured || confirming}
                >
                  <option value="">
                    {configured
                      ? "Use automatic default"
                      : "Lidarr is not configured"}
                  </option>
                  {rootFolders.map((folder) => (
                    <option key={folder.path} value={folder.path}>
                      {folder.path}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="artist-field-label">
                Quality Profile
              </label>
              <div className="artist-modal-field aurral-radius-round">
                <select
                  className="artist-modal-select"
                  value={qualityProfileId}
                  onChange={(e) => setQualityProfileId(e.target.value)}
                  disabled={!configured || confirming}
                >
                  <option value="">
                    {configured
                      ? "Use automatic default"
                      : "Lidarr is not configured"}
                  </option>
                  {qualityProfiles.map((profile) => (
                    <option key={profile.id} value={String(profile.id)}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="artist-field-label">
                Tag
              </label>
              <div className="artist-modal-field aurral-radius-round">
                <select
                  className="artist-modal-select"
                  value={tagId}
                  onChange={(e) => setTagId(e.target.value)}
                  disabled={!configured || confirming}
                >
                  <option value="">
                    {configured
                      ? "Use saved global default"
                      : "Lidarr is not configured"}
                  </option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={String(tag.id)}>
                      {tag.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <p className="artist-subtext">
              Leaving a field on automatic uses your saved Library Defaults, or
              the global Lidarr fallback when you do not have a saved default.
              Leaving tag on automatic uses the global Lidarr tag setting.
            </p>
          </div>
        )}

        <div className="artist-modal__actions">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
            disabled={confirming}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="btn btn-primary"
            disabled={loading || !configured || confirming}
          >
            {confirming ? "Adding..." : "Add Artist"}
          </button>
        </div>
      </div>
    </div>
  );
}

AddArtistCustomizeModal.propTypes = {
  show: PropTypes.bool,
  artistName: PropTypes.string,
  loading: PropTypes.bool,
  preferences: PropTypes.shape({
    configured: PropTypes.bool,
    rootFolders: PropTypes.arrayOf(
      PropTypes.shape({
        path: PropTypes.string,
      }),
    ),
    qualityProfiles: PropTypes.arrayOf(
      PropTypes.shape({
        id: PropTypes.number,
        name: PropTypes.string,
      }),
    ),
    tags: PropTypes.arrayOf(
      PropTypes.shape({
        id: PropTypes.number,
        label: PropTypes.string,
      }),
    ),
  }),
  rootFolderPath: PropTypes.string,
  setRootFolderPath: PropTypes.func,
  qualityProfileId: PropTypes.string,
  setQualityProfileId: PropTypes.func,
  tagId: PropTypes.string,
  setTagId: PropTypes.func,
  onClose: PropTypes.func,
  onConfirm: PropTypes.func,
  confirming: PropTypes.bool,
};
