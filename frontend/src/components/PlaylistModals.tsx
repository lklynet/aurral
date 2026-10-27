import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Plus, X } from "./icons";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { DotLoader } from "./DotLoader";
import TooltipButton from "./TooltipButton";

interface ModalShellProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  disableClose?: boolean;
  className?: string;
}

export function ModalShell({
  open,
  title,
  description = "",
  onClose,
  children,
  footer,
  disableClose = false,
  className = "",
}: ModalShellProps) {
  const titleId = useId();
  const descriptionId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open,
    onClose,
    closeDisabled: disableClose,
  });

  if (!open) return null;
  return (
    <div className="playlist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={`playlist-modal${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="playlist-modal__header">
          <div className="playlist-modal__heading">
            <h3 id={titleId} className="playlist-modal__title">
              {title}
            </h3>
            {description ? (
              <p id={descriptionId} className="playlist-modal__description">
                {description}
              </p>
            ) : null}
          </div>
          <TooltipButton
            type="button"
            onClick={disableClose ? undefined : onClose}
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Close"
            title="Close"
            disabled={disableClose}
          >
            <X className="artist-icon-sm" />
          </TooltipButton>
        </div>
        <div className="playlist-modal__body">{children}</div>
        {footer ? <div className="playlist-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

interface CreatePlaylistModalProps {
  open: boolean;
  defaultName?: string;
  saving?: boolean;
  error?: string;
  onClose: () => void;
  onSubmit?: (name: string) => void | Promise<void>;
}

export function CreatePlaylistModal({
  open,
  defaultName = "",
  saving = false,
  error = "",
  onClose,
  onSubmit,
}: CreatePlaylistModalProps) {
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
      className="playlist-modal--create"
      title="New playlist"
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
            {saving ? <DotLoader size="sm" label={null} /> : <Plus className="artist-icon-sm" />}
            Create playlist
          </button>
        </>
      }
    >
      <div className="playlist-modal__fields">
        <label className="artist-field-label" htmlFor="create-playlist-name">
          Playlist name
        </label>
        <input
          id="create-playlist-name"
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
        {localError || error ? <p className="artist-error-text">{localError || error}</p> : null}
      </div>
    </ModalShell>
  );
}
