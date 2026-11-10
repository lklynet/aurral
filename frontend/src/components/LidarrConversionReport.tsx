import { useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { libraryMonitoringClient } from "../utils/api/clients/libraryMonitoring.ts";
import { DotLoader } from "./DotLoader";

const LIDARR_DOCS = "https://docs.aurral.org/integrations/lidarr/";

export default function LidarrConversionReport() {
  const report = useAuth().bootstrap?.lidarrConversion;
  const { showSuccess, showError } = useToast();
  const [closed, setClosed] = useState(false);
  const [monitorArtists, setMonitorArtists] = useState(false);
  const titleId = useId();
  const doneRef = useRef(null);
  const open = Boolean(report) && !closed;

  const dismiss = useMutation({
    mutationFn: () =>
      parseResponse(
        libraryMonitoringClient["lidarr-conversion"].dismiss.$post({ json: { monitorArtists } }),
      ),
    onSuccess: ({ monitoredArtists }) => {
      setClosed(true);
      if (monitoredArtists > 0) {
        showSuccess(
          `Monitoring ${monitoredArtists.toLocaleString()} ${monitoredArtists === 1 ? "artist" : "artists"}.`,
        );
      }
    },
    onError: () => showError("Couldn't save your choice. Try again."),
  });

  const { dialogRef } = useModalDialog({
    open,
    onClose: () => setClosed(true),
    closeDisabled: dismiss.isPending,
    initialFocusRef: doneRef,
  });

  if (!report || !open) return null;
  const { artistCount, folders } = report;

  return (
    <div className="artist-modal-backdrop">
      <div
        ref={dialogRef}
        className="artist-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="artist-modal__title">
          Aurral runs your Library now
        </h3>
        <p className="artist-modal__subcopy">
          Lidarr&apos;s folders are read-only folders. Aurral plays their music and never changes
          it.
        </p>
        {folders.length > 0 ? (
          <ul className="lidarr-conversion__folders">
            {folders.map((folder) => (
              <li key={folder.path}>
                <code>{folder.path}</code>
                {folder.sharesLibraryFolder
                  ? " is inside the Library folder. Remove it in Settings > Library once Lidarr stops using it."
                  : null}
              </li>
            ))}
          </ul>
        ) : null}
        {artistCount > 0 ? (
          <label className="artist-checkbox-label">
            <input
              type="checkbox"
              checked={monitorArtists}
              onChange={(event) => setMonitorArtists(event.target.checked)}
              className="artist-checkbox"
            />
            <div>
              <span className="artist-card-title">
                {artistCount === 1
                  ? "Monitor this artist"
                  : `Monitor these ${artistCount.toLocaleString()} artists`}
              </span>
              <p className="artist-modal__subcopy">
                Uses your default rules in Settings &gt; Monitoring. Aurral downloads what is
                missing.
              </p>
            </div>
          </label>
        ) : null}
        <div className="artist-modal__actions lidarr-conversion__actions">
          <a
            className="lidarr-conversion__link"
            href={LIDARR_DOCS}
            target="_blank"
            rel="noopener noreferrer"
          >
            Add Lidarr as a download source
          </a>
          <button
            ref={doneRef}
            type="button"
            className="btn btn-primary"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            {dismiss.isPending ? <DotLoader size="sm" label={null} /> : null}
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
