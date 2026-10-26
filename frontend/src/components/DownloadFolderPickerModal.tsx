import { useCallback, useEffect, useRef, useState } from "react";
import { browseFilesystem, ensureFilesystemPath } from "../utils/api/endpoints/auth.ts";

import { createPortal } from "react-dom";
import { ArrowUp, Folder, X } from "./icons";
import { getApiErrorText } from "../pages/onboardingUtils.tsx";
import { asApiError } from "../utils/api/core.ts";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { DotLoader } from "./DotLoader";
interface FilesystemEntry {
  name: string;
  path: string;
}

interface FilesystemListing {
  path: string;
  displayPath?: string | null;
  entries?: FilesystemEntry[];
  parent?: string | null;
}

interface DownloadFolderPickerModalProps {
  initialPath?: string;
  createOnConfirm?: boolean;
  onConfirm?: (path: string) => void;
  onCancel: () => void;
}

function normalizeConfirmedPath(pathValue: string, browsePath: string) {
  const raw = String(pathValue ?? "").trim() || browsePath || "/";
  if (raw === "/") return "/";
  return raw.replace(/\/+$/, "");
}

export default function DownloadFolderPickerModal({
  initialPath = "",
  createOnConfirm = true,
  onConfirm,
  onCancel,
}: DownloadFolderPickerModalProps) {
  const [browsePath, setBrowsePath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<FilesystemEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);
  const openingPathRef = useRef(initialPath);
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: true,
    onClose: onCancel,
    closeDisabled: loading,
  });

  const applyBrowseResult = useCallback((result: FilesystemListing) => {
    setBrowsePath(result.path);
    setPathInput(result.displayPath ?? "");
    setEntries(Array.isArray(result.entries) ? result.entries : []);
    setParentPath(result.parent || null);
  }, []);

  const loadDirectory = useCallback(
    async (pathValue: string | undefined) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError("");
      try {
        const result = await browseFilesystem(pathValue || undefined);
        if (requestId !== requestIdRef.current) {
          return false;
        }
        applyBrowseResult(result);
        return true;
      } catch (err) {
        if (requestId !== requestIdRef.current) {
          return false;
        }
        setError(
          getApiErrorText(err, "message") ||
            asApiError(err)?.message ||
            "Failed to browse folders.",
        );
        return false;
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [applyBrowseResult],
  );

  const ensureDirectory = useCallback(
    async (pathValue: string) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError("");
      try {
        const result = await ensureFilesystemPath(pathValue);
        if (requestId !== requestIdRef.current) {
          return null;
        }
        applyBrowseResult(result);
        return result.path;
      } catch (err) {
        if (requestId !== requestIdRef.current) {
          return null;
        }
        setError(
          getApiErrorText(err, "message") ||
            asApiError(err)?.message ||
            "Failed to prepare folder path.",
        );
        return null;
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [applyBrowseResult],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const startPath = openingPathRef.current;
      if (startPath) {
        const opened = await loadDirectory(startPath);
        if (!cancelled && opened) return;
      }
      if (!cancelled) {
        await loadDirectory(undefined);
      }
    };
    run();
    return () => {
      cancelled = true;
      requestIdRef.current += 1;
    };
  }, [loadDirectory]);

  const handleNavigate = (nextPath: string) => {
    void loadDirectory(nextPath);
  };

  const handlePathSubmit = () => {
    const trimmed = pathInput.trim();
    if (!trimmed) {
      void loadDirectory(undefined);
      return;
    }
    void ensureDirectory(normalizeConfirmedPath(trimmed, browsePath));
  };

  const handleConfirm = async () => {
    const target = normalizeConfirmedPath(pathInput, browsePath);
    if (!createOnConfirm) {
      onConfirm?.(target);
      return;
    }
    const ensuredPath = await ensureDirectory(target);
    if (ensuredPath) {
      onConfirm?.(ensuredPath);
    }
  };

  return createPortal(
    <div
      className="artist-modal-backdrop file-browser-modal-backdrop"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className="file-browser-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-browser-title"
        tabIndex={-1}
      >
        <div className="file-browser-modal__header">
          <h3 id="file-browser-title" className="file-browser-modal__title">
            File browser
          </h3>
          <button
            type="button"
            className="file-browser-modal__close"
            onClick={onCancel}
            aria-label="Close"
          >
            <X className="artist-icon-xs" />
          </button>
        </div>

        <input
          type="text"
          className="file-browser-modal__path"
          autoComplete="off"
          spellCheck={false}
          placeholder="Enter or choose a folder."
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handlePathSubmit();
            }
          }}
        />

        <div className="file-browser-modal__table-wrap" aria-busy={loading}>
          <table className="file-browser-modal__table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Name</th>
              </tr>
            </thead>
            <tbody>
              {parentPath ? (
                <tr className="file-browser-modal__row" onClick={() => handleNavigate(parentPath)}>
                  <td>
                    <ArrowUp className="file-browser-modal__type-icon" />
                  </td>
                  <td>...</td>
                </tr>
              ) : null}
              {entries.map((entry) => (
                <tr
                  key={entry.path}
                  className="file-browser-modal__row"
                  onClick={() => handleNavigate(entry.path)}
                >
                  <td>
                    <Folder className="file-browser-modal__type-icon file-browser-modal__type-icon--folder" />
                  </td>
                  <td>{entry.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading ? (
            <p className="file-browser-modal__status">
              <DotLoader size="sm" label={null} /> Loading folders...
            </p>
          ) : null}
          {!loading && !parentPath && entries.length === 0 ? (
            <p className="file-browser-modal__status">No subfolders here.</p>
          ) : null}
        </div>

        {error ? <p className="file-browser-modal__error">{error}</p> : null}

        <div className="file-browser-modal__actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={loading}
          >
            Ok
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
