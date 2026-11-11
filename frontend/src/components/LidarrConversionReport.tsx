import { useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { useReadOnlyFolders } from "../hooks/useLibraryFileOperation.ts";
import { useSettingsRoute } from "../navigation/settingsRoute";
import { libraryMonitoringClient } from "../utils/api/clients/libraryMonitoring.ts";
import { DotLoader } from "./DotLoader";

const MOUNT_DOCS = "https://docs.aurral.org/getting-started/storage/#mount-a-read-only-folder";

export default function LidarrConversionReport() {
  const report = useAuth().bootstrap?.lidarrConversion;
  const unreadable = new Set(
    useReadOnlyFolders()
      .data?.folders.filter((folder) => !folder.readable)
      .map((folder) => folder.path),
  );
  const { showError } = useToast();
  const settings = useSettingsRoute();
  const [closed, setClosed] = useState(false);
  const titleId = useId();
  const doneRef = useRef(null);
  const open = Boolean(report) && !closed;

  const dismiss = useMutation({
    mutationFn: (_next: "done" | "plugins") =>
      parseResponse(libraryMonitoringClient["lidarr-conversion"].dismiss.$post()),
    onSuccess: (_result, next) => {
      setClosed(true);
      if (next === "plugins") settings.open("plugins");
    },
    onError: () => showError("Couldn't close the report. Try again."),
  });

  const { dialogRef } = useModalDialog({
    open,
    onClose: () => setClosed(true),
    closeDisabled: dismiss.isPending,
    initialFocusRef: doneRef,
  });

  if (!report || !open) return null;
  const { folders } = report;

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
          it. Lidarr keeps monitoring the artists it had, and Aurral monitors the ones you add.
        </p>
        {folders.length > 0 ? (
          <ul className="lidarr-conversion__folders">
            {folders.map((folder) => (
              <li key={folder.path}>
                <code>{folder.path}</code>
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
                    Mount Lidarr&apos;s music at <code>{folder.path}</code> in Aurral, or remove it
                    in Settings &gt; Library.{" "}
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
        <div className="artist-modal__actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate("plugins")}
          >
            Add Lidarr plugin
          </button>
          <button
            ref={doneRef}
            type="button"
            className="btn btn-primary"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate("done")}
          >
            {dismiss.isPending && dismiss.variables === "done" ? (
              <DotLoader size="sm" label={null} />
            ) : null}
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
