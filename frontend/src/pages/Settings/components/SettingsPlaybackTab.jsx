import { SettingsSelect } from "./SettingsField";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsPlaybackSection } from "./SettingsPlaybackSection";

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

        <SettingsArrFieldSet legend="Cover Art">
          <SettingsArrFormGroup
            label="Generated cover style"
            labelFor="playlist-artwork-style"
            help="Photo texture uses a random image from picsum with stylized typography. Aurral generated uses abstract palette covers."
          >
            <SettingsSelect
              id="playlist-artwork-style"
              value={playlistArtworkStyle}
              onChange={(event) =>
                updateSettings({
                  ...settings,
                  playlistArtwork: {
                    ...(settings.playlistArtwork || {}),
                    style: event.target.value,
                  },
                })
              }
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
