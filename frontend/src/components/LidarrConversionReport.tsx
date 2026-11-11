import { useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { useReadOnlyFolders } from "../hooks/useLibraryFileOperation.ts";
import { libraryMonitoringClient } from "../utils/api/clients/libraryMonitoring.ts";
import { DotLoader } from "./DotLoader";

const LIDARR_DOCS = "https://docs.aurral.org/integrations/lidarr/";
const MOUNT_DOCS = "https://docs.aurral.org/getting-started/storage/#mount-a-read-only-folder";

export default function LidarrConversionReport() {
  const report = useAuth().bootstrap?.lidarrConversion;
  const unreadable = new Set(
    useReadOnlyFolders()
      .data?.folders.filter((folder) => !folder.readable)
      .map((folder) => folder.path),
  );
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
                {folder.lidarrPath === folder.path ? null : (
                  <span>
                    Lidarr sees it as <code>{folder.lidarrPath}</code>. Use both paths when you add
                    the Lidarr plugin.
                  </span>
                )}
                {folder.sharesLibraryFolder ? (
                  <span>
                    Inside the Library folder. Remove it in Settings &gt; Library once Lidarr stops
                    using it.
                  </span>
                ) : null}
                {unreadable.has(folder.path) ? (
                  <span>
                    <span className="lidarr-conversion__warning">
                      Aurral cannot read this folder.
                    </span>{" "}
                    Mount Lidarr&apos;s music at this path, or remove it in Settings &gt; Library.{" "}
                    <a
                      className="lidarr-conversion__link"
                      href={MOUNT_DOCS}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Storage docs
                    </a>
                  </span>
                ) : null}
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
                  ? "Monitor this artist with your default rules"
                  : `Monitor these ${artistCount.toLocaleString()} artists with your default rules`}
              </span>
              <p className="artist-modal__subcopy">
                {artistCount === 1
                  ? "You monitored it through Aurral 2. Aurral downloads its missing albums using Settings > Monitoring."
                  : "You monitored them through Aurral 2. Aurral downloads their missing albums using Settings > Monitoring."}
              </p>
            </div>
          </label>
        ) : null}
        <p className="artist-modal__subcopy">
          Artists Lidarr already had start Not monitored. Monitor them from their artist page.
        </p>
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
