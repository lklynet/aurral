import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { ImagePlus, Link as LinkIcon, Upload, X } from "./icons";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import ArtworkImage from "./ArtworkImage.tsx";
import Tooltip from "./Tooltip.tsx";
import TooltipButton from "./TooltipButton.tsx";
import { getApiErrorMessage, getApiErrorText } from "../pages/onboardingUtils.tsx";
import { asApiError } from "../utils/api/core.ts";
import { cacheImageLocally } from "../utils/api/endpoints/images.ts";
import type { CustomArtworkResult } from "../utils/api/endpoints/library.ts";

const isWebUrl = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

interface ArtworkEditorModalProps {
  open: boolean;
  title: string;
  currentArtwork?: string | null;
  hasCustomArtwork?: boolean;
  onClose: () => void;
  onUpload: (file: File) => Promise<CustomArtworkResult>;
  onSaveUrl: (url: string) => Promise<CustomArtworkResult>;
  onRemove: () => Promise<CustomArtworkResult>;
  onSaved?: (result: CustomArtworkResult) => void | Promise<void>;
}

export default function ArtworkEditorModal({
  open,
  title,
  currentArtwork,
  hasCustomArtwork = false,
  onClose,
  onUpload,
  onSaveUrl,
  onRemove,
  onSaved,
}: ArtworkEditorModalProps) {
  const titleId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState("");
  const [url, setUrl] = useState("");
  const [urlPreview, setUrlPreview] = useState("");
  const [source, setSource] = useState<"file" | "url" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { dialogRef, handleBackdropClick } = useModalDialog({ open, onClose, closeDisabled: busy });

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setFilePreview("");
    setUrl("");
    setUrlPreview("");
    setSource(null);
    setError("");
  }, [open, title]);

  useEffect(
    () => () => {
      if (filePreview) URL.revokeObjectURL(filePreview);
    },
    [filePreview],
  );

  useEffect(() => {
    const candidate = url.trim();
    if (!open || source !== "url" || !isWebUrl(candidate)) {
      setUrlPreview("");
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      cacheImageLocally(candidate)
        .then((previewUrl) => {
          if (!cancelled) setUrlPreview(previewUrl || "");
        })
        .catch(() => {
          if (!cancelled) setUrlPreview("");
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, source, url]);

  if (!open) return null;

  const chooseFile = (nextFile: File | null | undefined) => {
    if (!nextFile) return;
    if (!nextFile.type?.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }
    if (filePreview) URL.revokeObjectURL(filePreview);
    setFile(nextFile);
    setFilePreview(URL.createObjectURL(nextFile));
    setSource("file");
    setError("");
  };

  const handleUrlChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setUrl(value);
    setUrlPreview("");
    setSource(value.trim() ? "url" : file ? "file" : null);
    setError("");
  };

  const handleSave = async () => {
    if (source === "url" && !isWebUrl(url.trim())) {
      setError("Enter a valid http or https image link.");
      return;
    }
    if (source !== "url" && !file) {
      setError("Choose an image or enter an image link.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = source === "url" ? await onSaveUrl(url.trim()) : await onUpload(file as File);
      await onSaved?.(result);
      onClose();
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Artwork could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await onRemove();
      await onSaved?.(result);
      onClose();
    } catch (requestError) {
      setError(
        getApiErrorText(requestError, "message") ||
          asApiError(requestError)?.message ||
          "Artwork could not be removed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const preview = source === "file" ? filePreview : source === "url" ? urlPreview : "";
  const encodedPreview = (() => {
    if (!preview) return "";
    try {
      return encodeURI(preview);
    } catch {
      return "";
    }
  })();

  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="settings-page__modal settings-page__modal--integration artwork-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="settings-page__modal-header">
          <div>
            <h3 id={titleId} className="settings-page__modal-title">
              Change artwork
            </h3>
            <p className="artwork-editor__subtitle">{title}</p>
          </div>
          <TooltipButton
            type="button"
            className="btn btn-ghost btn-icon-square"
            onClick={onClose}
            disabled={busy}
            label="Close"
            aria-label="Close"
          >
            <X className="artist-icon-md" aria-hidden="true" />
          </TooltipButton>
        </div>
        <div className="settings-page__modal-body">
          <div className="artwork-editor__artwork-row">
            <section className="artwork-editor__section">
              <span className="artwork-editor__label">Current artwork</span>
              <div className="artwork-editor__current">
                {currentArtwork ? (
                  <ArtworkImage src={currentArtwork} alt="Current artwork" thumbnail={false} />
                ) : (
                  <ImagePlus aria-hidden="true" />
                )}
              </div>
            </section>

            <section className="artwork-editor__section">
              <span className="artwork-editor__label">Upload an image</span>
              <button
                type="button"
                className={`artwork-editor__dropzone${source === "file" ? " is-selected" : ""}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  chooseFile(event.dataTransfer.files?.[0]);
                }}
                disabled={busy}
              >
                <Upload aria-hidden="true" />
                <Tooltip content={file?.name || ""} placement="top">
                  <strong>{file?.name || "Drop an image here"}</strong>
                </Tooltip>
                <span>or click to choose a file</span>
              </button>
              <input
                ref={fileInputRef}
                className="artwork-editor__file-input"
                type="file"
                accept="image/*"
                onChange={(event) => chooseFile(event.target.files?.[0])}
              />
            </section>
          </div>

          <section className="artwork-editor__section">
            <label className="artwork-editor__label" htmlFor={`${titleId}-url`}>
              Use an image link
            </label>
            <div className="artwork-editor__url-row">
              <LinkIcon aria-hidden="true" />
              <input
                id={`${titleId}-url`}
                className="input input--tall"
                type="url"
                value={url}
                onChange={handleUrlChange}
                placeholder="https://example.com/cover.jpg"
                disabled={busy}
              />
            </div>
          </section>

          {encodedPreview ? (
            <section className="artwork-editor__section">
              <span className="artwork-editor__label">New artwork preview</span>
              <div className="artwork-editor__preview">
                <ArtworkImage
                  src={encodedPreview}
                  alt="New artwork preview"
                  thumbnail={false}
                  onError={() => setError("That image could not be previewed.")}
                />
              </div>
            </section>
          ) : null}
          {error ? (
            <p className="artwork-editor__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="settings-page__modal-actions artwork-editor__actions">
          {hasCustomArtwork ? (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={handleRemove}
              disabled={busy}
            >
              Remove custom artwork
            </button>
          ) : (
            <span />
          )}
          <div className="artwork-editor__actions-main">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={busy || !source}
            >
              {busy ? "Saving…" : "Save artwork"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
