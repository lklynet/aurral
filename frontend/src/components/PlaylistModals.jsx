import { useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  MoreVertical,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";

function ModalShell({
  open,
  title,
  description = "",
  onClose,
  children,
  footer,
  disableClose = false,
}) {
  if (!open) return null;
  return (
    <div
      className="playlist-modal-backdrop"
      onClick={disableClose ? undefined : onClose}
    >
      <div className="playlist-modal" onClick={(event) => event.stopPropagation()}>
        <div className="playlist-modal__header">
          <div className="playlist-modal__heading">
            <h3 className="playlist-modal__title">{title}</h3>
            {description ? (
              <p className="playlist-modal__description">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={disableClose ? undefined : onClose}
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Close"
            disabled={disableClose}
          >
            <X className="artist-icon-sm" />
          </button>
        </div>
        <div className="playlist-modal__body">{children}</div>
        {footer ? <div className="playlist-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function CreatePlaylistModal({
  open,
  defaultName = "",
  saving = false,
  error = "",
  onClose,
  onSubmit,
}) {
  const [name, setName] = useState(defaultName);
  const [localError, setLocalError] = useState("");
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setName(defaultName);
      setLocalError("");
    }
    wasOpenRef.current = open;
  }, [defaultName, open]);

  const handleSubmit = async () => {
    const nextName = String(name || "").trim();
    if (!nextName) {
      setLocalError("Playlist name is required");
      return;
    }
    setLocalError("");
    await onSubmit?.(nextName);
  };

  return (
    <ModalShell
      open={open}
      title="New Playlist"
      description="Create a manual playlist you can build up track by track."
      onClose={onClose}
      disableClose={saving}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary btn-sm"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="btn btn-primary btn-sm"
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="artist-icon-sm animate-spin" />
            ) : (
              <Plus className="artist-icon-sm" />
            )}
            Create Playlist
          </button>
        </>
      }
    >
      <div className="playlist-modal__fields">
        <label className="artist-field-label">Playlist Name</label>
        <input
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (localError) setLocalError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSubmit();
            }
          }}
          className="input input--tall"
          placeholder="Night Drive"
          autoFocus
        />
        {localError || error ? (
          <p className="artist-error-text">{localError || error}</p>
        ) : null}
      </div>
    </ModalShell>
  );
}

export function RenamePlaylistModal({
  open,
  title,
  defaultName = "",
  displayName = "",
  artworkUrl = "",
  saving = false,
  coverBusy = false,
  error = "",
  coverError = "",
  onClose,
  onSubmit,
  onUpload,
  onRemoveCover,
  onGenerateCover,
}) {
  const [name, setName] = useState(defaultName);
  const [localError, setLocalError] = useState("");
  const [previewUrl, setPreviewUrl] = useState(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [coverMenuOpen, setCoverMenuOpen] = useState(false);
  const fileInputRef = useRef(null);
  const coverMenuRef = useRef(null);
  const wasOpenRef = useRef(false);
  const busy = saving || coverBusy;

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setName(defaultName);
      setLocalError("");
      setImageFailed(false);
      setCoverMenuOpen(false);
      setPreviewUrl((prev) => {
        if (prev?.startsWith("blob:")) {
          URL.revokeObjectURL(prev);
        }
        return null;
      });
    }
    wasOpenRef.current = open;
  }, [defaultName, open]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (coverMenuRef.current && !coverMenuRef.current.contains(event.target)) {
        setCoverMenuOpen(false);
      }
    };
    if (coverMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [coverMenuOpen]);

  useEffect(() => {
    setImageFailed(false);
  }, [artworkUrl]);

  useEffect(
    () => () => {
      if (previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
    },
    [previewUrl],
  );

  const handleSubmit = async () => {
    const nextName = String(name || "").trim();
    if (!nextName) {
      setLocalError("Name is required");
      return;
    }
    setLocalError("");
    await onSubmit?.(nextName);
  };

  const openFilePicker = () => {
    if (busy) return;
    fileInputRef.current?.click();
  };

  const handleRemove = async () => {
    setCoverMenuOpen(false);
    setPreviewUrl((prev) => {
      if (prev?.startsWith("blob:")) {
        URL.revokeObjectURL(prev);
      }
      return null;
    });
    setImageFailed(true);
    await onRemoveCover?.();
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!String(file.type || "").startsWith("image/")) {
      setLocalError("Choose an image file");
      return;
    }
    const blobUrl = URL.createObjectURL(file);
    setPreviewUrl((prev) => {
      if (prev?.startsWith("blob:")) {
        URL.revokeObjectURL(prev);
      }
      return blobUrl;
    });
    setImageFailed(false);
    setLocalError("");
    await onUpload?.(file);
  };

  const coverSrc =
    previewUrl || (!imageFailed && artworkUrl ? artworkUrl : null);
  const fallbackLabel =
    String(displayName || name || "?")
      .trim()
      .charAt(0)
      .toUpperCase() || "?";
  const combinedError = localError || coverError || error;

  return (
    <ModalShell
      open={open}
      title={title}
      onClose={onClose}
      disableClose={busy}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="flow-page__hidden-input"
        onChange={handleFileChange}
      />
      <div className="playlist-modal__edit-layout">
        <div className="playlist-modal__edit-cover">
          <div
            className={`playlist-modal__cover-wrap${coverMenuOpen ? " is-menu-open" : ""}`}
            ref={coverMenuRef}
          >
            <button
              type="button"
              className="playlist-modal__cover-picker"
              disabled={busy}
              onClick={openFilePicker}
              aria-label="Change cover image"
            >
              {coverSrc ? (
                <img
                  src={coverSrc}
                  alt=""
                  onError={() => setImageFailed(true)}
                />
              ) : (
                <div className="playlist-modal__cover-fallback">
                  {fallbackLabel}
                </div>
              )}
              <span className="playlist-modal__cover-picker-overlay">
                Change image
              </span>
            </button>
            <div className="playlist-modal__cover-menu">
              <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm playlist-modal__cover-menu-trigger"
              disabled={busy}
              aria-label="Cover image options"
              aria-expanded={coverMenuOpen}
              aria-haspopup="menu"
              onClick={(event) => {
                event.stopPropagation();
                setCoverMenuOpen((prev) => !prev);
              }}
            >
              <MoreVertical className="artist-icon-sm" />
              </button>
              {coverMenuOpen ? (
                <>
                  <button
                    type="button"
                    className="artist-backdrop-button playlist-modal__cover-menu-backdrop"
                    onClick={() => setCoverMenuOpen(false)}
                    aria-label="Close cover menu"
                  />
                  <div
                    className="artist-dropdown artist-dropdown--right playlist-modal__cover-dropdown"
                    role="menu"
                    onClick={() => setCoverMenuOpen(false)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="artist-menu-item"
                      disabled={busy}
                      onClick={openFilePicker}
                    >
                      <span className="artist-menu-item__main">
                        <Upload className="artist-icon-sm" />
                        Upload
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="artist-menu-item"
                      disabled={busy}
                      onClick={() => onGenerateCover?.()}
                    >
                      <span className="artist-menu-item__main">
                        {coverBusy ? (
                          <Loader2 className="artist-icon-sm animate-spin" />
                        ) : (
                          <Sparkles className="artist-icon-sm" />
                        )}
                        Generate
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="artist-menu-item artist-menu-item--danger"
                      disabled={busy || !coverSrc}
                      onClick={handleRemove}
                    >
                      <span className="artist-menu-item__main">
                        <Trash2 className="artist-icon-sm" />
                        Remove
                      </span>
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div className="playlist-modal__edit-panel">
          <div className="playlist-modal__edit-panel-main">
            <div className="artist-modal-field aurral-radius-round artist-modal-field--text">
              <input
                type="text"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (localError) setLocalError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleSubmit();
                  }
                }}
                className="artist-input"
                aria-label={title}
                autoFocus
              />
            </div>
            {combinedError ? (
              <p className="artist-error-text">{combinedError}</p>
            ) : null}
          </div>
          <div className="playlist-modal__edit-actions">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary btn-sm"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              className="btn btn-primary btn-sm"
              disabled={busy}
            >
              {saving ? (
                <Loader2 className="artist-icon-sm animate-spin" />
              ) : (
                <Check className="artist-icon-sm" />
              )}
              Save
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
