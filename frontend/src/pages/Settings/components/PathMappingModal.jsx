import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, X } from "lucide-react";
import DownloadFolderPickerModal from "../../../components/DownloadFolderPickerModal";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import { SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { useModalDialog } from "../../../hooks/useModalDialog.js";

const PATH_MAPPING_SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "lidarr", label: "Lidarr" },
  { value: "slskd", label: "slskd" },
  { value: "nzbget", label: "NZBGet" },
  { value: "sabnzbd", label: "SABnzbd" },
  { value: "plex", label: "Plex" },
  { value: "jellyfin", label: "Jellyfin" },
];

const EMPTY_MAPPING = { source: "all", remote: "", local: "" };

export function PathMappingModal({ title, initialValue, onClose, onSave }) {
  const [draft, setDraft] = useState(() => ({
    ...EMPTY_MAPPING,
    ...initialValue,
  }));
  const [showPicker, setShowPicker] = useState(false);
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: true,
    onClose,
  });

  useEffect(() => {
    setDraft({ ...EMPTY_MAPPING, ...initialValue });
  }, [initialValue]);

  const handleSave = () => {
    const mapping = {
      source: String(draft.source || "all")
        .trim()
        .toLowerCase(),
      remote: String(draft.remote || "").trim(),
      local: String(draft.local || "").trim(),
    };
    if (!mapping.remote || !mapping.local) return;
    onSave(mapping);
  };

  const canSave =
    Boolean(String(draft.remote || "").trim()) && Boolean(String(draft.local || "").trim());

  return createPortal(
    <div className="arr-portal">
      <div className="arr-modal-backdrop" onClick={handleBackdropClick}>
        <div
          ref={dialogRef}
          className="arr-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="path-mapping-modal-title"
          tabIndex={-1}
        >
          <div className="arr-modal__header">
            <h3 id="path-mapping-modal-title" className="arr-modal__title">
              {title}
            </h3>
            <button
              type="button"
              className="arr-btn arr-btn--ghost arr-btn--icon"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="artist-icon-md" />
            </button>
          </div>
          <div className="arr-modal__body">
            <SettingsArrFormGroup
              label="Applies to"
              help="Limit this mapping to paths reported by a specific integration, or use all sources."
            >
              <SettingsSelect
                value={draft.source}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    source: event.target.value,
                  }))
                }
              >
                {PATH_MAPPING_SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SettingsSelect>
            </SettingsArrFormGroup>
            <SettingsArrFormGroup
              label="Remote path"
              help="Path the other app reports, such as a host-only mount path from Lidarr or NZBGet."
            >
              <SettingsInput
                value={draft.remote}
                placeholder="/data/media/music"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    remote: event.target.value,
                  }))
                }
              />
            </SettingsArrFormGroup>
            <SettingsArrFormGroup
              label="Local path"
              help="Path Aurral should use inside its container to read that remote path."
            >
              <div className="arr-path-input">
                <SettingsInput
                  className="arr-path-input__field"
                  value={draft.local}
                  placeholder="/data/media/music"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      local: event.target.value,
                    }))
                  }
                />
                <button
                  type="button"
                  className="arr-path-input__browse"
                  onClick={() => setShowPicker(true)}
                  aria-label="Browse folders"
                >
                  <Folder className="artist-icon-xs" />
                </button>
              </div>
            </SettingsArrFormGroup>
          </div>
          <div className="arr-modal__footer">
            <button type="button" className="arr-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="arr-btn arr-btn--primary"
              onClick={handleSave}
              disabled={!canSave}
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {showPicker ? (
        <DownloadFolderPickerModal
          initialPath={draft.local}
          createOnConfirm={false}
          onConfirm={(path) => {
            setDraft((current) => ({
              ...current,
              local: String(path || "").trim(),
            }));
            setShowPicker(false);
          }}
          onCancel={() => setShowPicker(false)}
        />
      ) : null}
    </div>,
    document.body,
  );
}

export { PATH_MAPPING_SOURCE_OPTIONS };
