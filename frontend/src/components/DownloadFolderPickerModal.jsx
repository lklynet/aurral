import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { ArrowUp, Folder, X } from "lucide-react";
import { browseFilesystem, ensureFilesystemPath } from "../utils/api";

function normalizeConfirmedPath(pathValue, browsePath) {
  const raw = String(pathValue ?? "").trim() || browsePath || "/";
  if (raw === "/") return "/";
  return raw.replace(/\/+$/, "");
}

export default function DownloadFolderPickerModal({
  initialPath = "",
  onConfirm,
  onCancel,
}) {
  const [browsePath, setBrowsePath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState([]);
  const [parentPath, setParentPath] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestIdRef = useRef(0);
  const openingPathRef = useRef(initialPath);

  const applyBrowseResult = useCallback((result) => {
    setBrowsePath(result.path);
    setPathInput(result.displayPath ?? "");
    setEntries(Array.isArray(result.entries) ? result.entries : []);
    setParentPath(result.parent || null);
  }, []);

  const loadDirectory = useCallback(async (pathValue) => {
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
        err?.response?.data?.message ||
          err?.message ||
          "Failed to browse folders.",
      );
      return false;
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [applyBrowseResult]);

  const ensureDirectory = useCallback(
    async (pathValue) => {
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
          err?.response?.data?.message ||
            err?.message ||
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

  const handleNavigate = (nextPath) => {
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
    const ensuredPath = await ensureDirectory(target);
    if (ensuredPath) {
      onConfirm?.(ensuredPath);
    }
  };

  return createPortal(
    <div className="artist-modal-backdrop file-browser-modal-backdrop" onClick={onCancel}>
      <div
        className="file-browser-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="file-browser-title"
      >
        <div className="file-browser-modal__header">
          <h3 id="file-browser-title" className="file-browser-modal__title">
            File Browser
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
          placeholder="Start typing or select a path below"
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
                <tr
                  className="file-browser-modal__row"
                  onClick={() => handleNavigate(parentPath)}
                >
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
            <p className="file-browser-modal__status">Loading folders...</p>
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

DownloadFolderPickerModal.propTypes = {
  initialPath: PropTypes.string,
  onConfirm: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};
