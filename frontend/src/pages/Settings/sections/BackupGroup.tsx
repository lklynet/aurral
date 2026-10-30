import { useRef, useState } from "react";
import { parseResponse } from "hono/client";
import { DotLoader } from "../../../components/DotLoader";
import { backupClient } from "../../../utils/api/clients/backup.ts";
import { healthClient } from "../../../utils/api/clients/health.ts";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.ts";
import { getApiErrorMessage } from "../../onboardingUtils.tsx";
import { useServerSettings } from "../SettingsProviders";
import { SettingsGroup, SettingsRow } from "../SettingsLayout";

type Restore =
  | { step: "idle"; error?: string }
  | { step: "confirm"; file: File; uploading?: boolean }
  | { step: "restarting" };

const isUp = () =>
  healthClient.live.$get().then(
    (res) => res.ok,
    () => false,
  );
const pause = () => new Promise((resolve) => setTimeout(resolve, 1000));

async function reloadAfterRestart() {
  const deadline = Date.now() + 30_000;
  do await pause();
  while (Date.now() < deadline && (await isUp()));
  do await pause();
  while (!(await isUp()));
  window.location.reload();
}

export function BackupGroup() {
  const { showError } = useServerSettings();
  const fileInput = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [restore, setRestore] = useState<Restore>({ step: "idle" });

  const download = async () => {
    setDownloading(true);
    try {
      let res;
      try {
        res = await backupClient.$get();
      } catch (error) {
        if (!isReauthRequiredError(error) || !(await promptReauth())) throw error;
        res = await backupClient.$get();
      }
      const url = URL.createObjectURL(await res.blob());
      const date = new Date().toLocaleDateString("en-CA");
      Object.assign(document.createElement("a"), {
        href: url,
        download: `aurral-backup-${date}.zip`,
      }).click();
      URL.revokeObjectURL(url);
    } catch (error) {
      if (!isReauthRequiredError(error))
        showError(getApiErrorMessage(error, "Couldn't create a backup."));
    } finally {
      setDownloading(false);
    }
  };

  const restoreFrom = async (file: File) => {
    setRestore({ step: "confirm", file, uploading: true });
    try {
      await parseResponse(
        backupClient.restore.$post(
          {},
          { headers: { "Content-Type": "application/zip" }, init: { body: file } },
        ),
      );
      setRestore({ step: "restarting" });
      await reloadAfterRestart();
    } catch (error) {
      setRestore({
        step: "idle",
        error: getApiErrorMessage(error, "Couldn't restore this backup."),
      });
    }
  };

  return (
    <SettingsGroup title="Backup">
      <SettingsRow
        label="Back up"
        help="Settings, users, playlists, history, and custom artwork. Music files are not included."
      >
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={download}
          disabled={downloading}
        >
          {downloading ? <DotLoader size="xs" label={null} /> : null}
          Download backup
        </button>
      </SettingsRow>
      {restore.step === "confirm" ? (
        <SettingsRow
          label={`Restore ${restore.file.name}?`}
          help="Everything on this server is replaced and everyone is signed out."
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setRestore({ step: "idle" })}
            disabled={restore.uploading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => void restoreFrom(restore.file)}
            disabled={restore.uploading}
          >
            {restore.uploading ? <DotLoader size="xs" label={null} /> : null}
            Restore
          </button>
        </SettingsRow>
      ) : restore.step === "restarting" ? (
        <SettingsRow
          label="Restoring"
          help="Aurral is restarting. This page reloads when it is back."
        />
      ) : (
        <SettingsRow
          label="Restore"
          help={
            restore.error ??
            "Replaces everything on this server with a backup, then restarts Aurral."
          }
          tone={restore.error ? "error" : "default"}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) setRestore({ step: "confirm", file });
            }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => fileInput.current?.click()}
          >
            Choose backup
          </button>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
