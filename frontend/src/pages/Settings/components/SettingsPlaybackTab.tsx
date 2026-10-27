import type { FormEvent } from "react";
import { SettingsSelect } from "./SettingsField";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsPlaybackSection } from "./SettingsPlaybackSection";
import type { InferResponseType } from "hono/client";
import type { playbackSettingsClient } from "../../../utils/api/clients/playbackSettings.ts";
import type { useToast } from "../../../contexts/ToastContext";
import type { SettingsState } from "../utils";

type Toast = ReturnType<typeof useToast>["showSuccess"];

const PLAYLIST_ARTWORK_STYLE_OPTIONS = [
  { value: "photo", label: "Photo texture" },
  { value: "aurral", label: "Aurral generated" },
];

export function SettingsPlaybackTab({
  settings,
  playbackSettings,
  updateSettings,
  hasUnsavedChanges,
  handleSaveSettings,
  showSuccess,
  showError,
  showInfo,
}: {
  settings: SettingsState;
  playbackSettings:
    | InferResponseType<typeof playbackSettingsClient.playback.$get, 200>["destinations"]
    | null;
  updateSettings: (settings: SettingsState) => void;
  hasUnsavedChanges: boolean;
  saving: boolean;
  handleSaveSettings: (
    event?: FormEvent<HTMLFormElement> | null,
    settingsOverride?: SettingsState,
  ) => Promise<boolean>;
  showSuccess: Toast;
  showError: Toast;
  showInfo: ReturnType<typeof useToast>["showInfo"];
}) {
  const playlistArtworkStyle = settings.playlistArtwork?.style === "aurral" ? "aurral" : "photo";

  return (
    <div className="arr-page">
      <form onSubmit={handleSaveSettings} className="arr-form" autoComplete="off">
        <SettingsPlaybackSection
          settings={settings}
          playbackSettings={playbackSettings}
          updateSettings={updateSettings}
          hasUnsavedChanges={hasUnsavedChanges}
          handleSaveSettings={handleSaveSettings}
          showSuccess={showSuccess}
          showError={showError}
          showInfo={showInfo}
        />

        <SettingsArrFieldSet legend="Cover art">
          <SettingsArrFormGroup
            label="Generated cover style"
            labelFor="playlist-artwork-style"
            help="Photo texture uses photos. Aurral generated uses abstract covers."
          >
            <SettingsSelect
              id="playlist-artwork-style"
              value={playlistArtworkStyle}
              onChange={(event) => {
                const style = event.target.value;
                if (style !== "aurral" && style !== "photo") return;
                updateSettings({
                  ...settings,
                  playlistArtwork: {
                    ...(settings.playlistArtwork || {}),
                    style,
                  },
                });
              }}
            >
              {PLAYLIST_ARTWORK_STYLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SettingsSelect>
          </SettingsArrFormGroup>
        </SettingsArrFieldSet>
      </form>
    </div>
  );
}
