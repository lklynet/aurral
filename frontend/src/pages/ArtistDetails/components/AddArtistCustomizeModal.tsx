import { useId } from "react";
import { DotLoader } from "../../../components/DotLoader";
import { useModalDialog } from "../../../hooks/useModalDialog.ts";
import AddActionButton from "../../../components/AddActionButton";
import { MONITOR_OPTIONS } from "../../../utils/aurralMonitoring";
import type { InferResponseType } from "hono/client";
import type { usersClient } from "../../../utils/api/clients/users.ts";

type LidarrPreferencesResponse = InferResponseType<
  (typeof usersClient.me)["lidarr-preferences"]["$get"],
  200
>;

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
  monitorOption,
  setMonitorOption,
  onClose,
  onConfirm,
  confirming,
  error,
}: {
  show: boolean;
  artistName: string | undefined;
  loading: boolean;
  preferences: LidarrPreferencesResponse | null;
  rootFolderPath: string;
  setRootFolderPath: (value: string) => void;
  qualityProfileId: string;
  setQualityProfileId: (value: string) => void;
  tagId: string;
  setTagId: (value: string) => void;
  monitorOption: string;
  setMonitorOption: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  confirming: boolean;
  error: string | null | undefined;
}) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: show,
    onClose,
    closeDisabled: confirming,
  });

  if (!show) return null;

  const rootFolders = Array.isArray(preferences?.rootFolders) ? preferences.rootFolders : [];
  const qualityProfiles = Array.isArray(preferences?.qualityProfiles)
    ? preferences.qualityProfiles
    : [];
  const tags = Array.isArray(preferences?.tags) ? preferences.tags : [];
  const configured = preferences?.configured === true;

  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="artist-modal__header">
          <h3 id={titleId} className="artist-modal__title">
            Customize Lidarr add{artistName ? `: ${artistName}` : ""}
          </h3>
        </div>
        <p className="artist-modal__subcopy">Applies to this add only.</p>

        {loading ? (
          <div className="artist-loading">
            <DotLoader size="xl" label={null} />
          </div>
        ) : (
          <div className="artist-modal__fields">
            <div>
              <label className="artist-field-label" htmlFor={`${titleId}-monitor`}>
                Monitoring
              </label>
              <div className="artist-modal-field aurral-radius-round">
                <select
                  id={`${titleId}-monitor`}
                  className="artist-modal-select"
                  value={monitorOption}
                  onChange={(e) => setMonitorOption(e.target.value)}
                  disabled={!configured || confirming}
                >
                  <option value="">
                    {configured ? "Use default monitoring" : "Lidarr is not configured"}
                  </option>
                  {MONITOR_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.value === "none" ? "Add without monitoring" : option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="artist-field-label">Root folder</label>
              <div className="artist-modal-field aurral-radius-round">
                <select
                  className="artist-modal-select"
                  value={rootFolderPath}
                  onChange={(e) => setRootFolderPath(e.target.value)}
                  disabled={!configured || confirming}
                >
                  <option value="">
                    {configured ? "Use automatic default" : "Lidarr is not configured"}
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
              <label className="artist-field-label">Quality profile</label>
              <div className="artist-modal-field aurral-radius-round">
                <select
                  className="artist-modal-select"
                  value={qualityProfileId}
                  onChange={(e) => setQualityProfileId(e.target.value)}
                  disabled={!configured || confirming}
                >
                  <option value="">
                    {configured ? "Use automatic default" : "Lidarr is not configured"}
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
              <label className="artist-field-label">Tag</label>
              <div className="artist-modal-field aurral-radius-round">
                <select
                  className="artist-modal-select"
                  value={tagId}
                  onChange={(e) => setTagId(e.target.value)}
                  disabled={!configured || confirming}
                >
                  <option value="">
                    {configured ? "Use saved global default" : "Lidarr is not configured"}
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
              Automatic uses your Library defaults, then Lidarr defaults. Tags use the global Lidarr
              setting.
            </p>
          </div>
        )}

        {error ? (
          <p className="artist-subtext" role="alert">
            {error}
          </p>
        ) : null}
        <div className="artist-modal__actions">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
            disabled={confirming}
          >
            Cancel
          </button>
          <AddActionButton
            type="button"
            onClick={onConfirm}
            label="Add to Lidarr"
            className="btn-primary"
            disabled={loading || !configured || confirming}
          >
            {confirming ? <DotLoader size="sm" label={null} /> : null}
            {confirming ? "Adding to Lidarr..." : "Add to Lidarr"}
          </AddActionButton>
        </div>
      </div>
    </div>
  );
}
