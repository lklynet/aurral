import { useState } from "react";
import { CheckCircle, Pencil } from "lucide-react";
import FlipSaveButton from "../../../components/FlipSaveButton";

export function SettingsMetadataTab({
  settings,
  updateSettings,
  health,
  hasUnsavedChanges,
  saving,
  handleSaveSettings,
}) {
  const [musicbrainzEditing, setMusicbrainzEditing] = useState(false);
  const [lastfmEditing, setLastfmEditing] = useState(false);

  return (
    <div className="card animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <h2
          className="text-2xl font-bold flex items-center"
          style={{ color: "#fff" }}
        >
          Metadata Services
        </h2>
        <FlipSaveButton
          saving={saving}
          disabled={!hasUnsavedChanges}
          onClick={handleSaveSettings}
        />
      </div>
      <form
        onSubmit={handleSaveSettings}
        className="space-y-6"
        autoComplete="off"
      >
        <div
          className="p-6 rounded-lg space-y-4"
          style={{
            backgroundColor: "#1a1a1e",
            border: "1px solid #2a2a2e",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3
              className="text-lg font-medium flex items-center"
              style={{ color: "#fff" }}
            >
              MusicBrainz
            </h3>
            <div className="flex items-center gap-2">
              {health?.musicbrainzConfigured && (
                <span className="flex items-center text-sm text-green-400">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Configured
                </span>
              )}
              <button
                type="button"
                className={`btn ${
                  musicbrainzEditing ? "btn-primary" : "btn-secondary"
                } px-2 py-1`}
                onClick={() => setMusicbrainzEditing((value) => !value)}
                aria-label={
                  musicbrainzEditing
                    ? "Lock MusicBrainz settings"
                    : "Edit MusicBrainz settings"
                }
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          </div>
          <fieldset
            disabled={!musicbrainzEditing}
            className={`${musicbrainzEditing ? "" : "opacity-60"}`}
          >
            <div>
            <label
              className="block text-sm font-medium mb-1"
              style={{ color: "#fff" }}
            >
              Contact Email (Required)
            </label>
            <input
              type="email"
              className="input"
              placeholder="contact@example.com"
              autoComplete="off"
              value={settings.integrations?.musicbrainz?.email || ""}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  integrations: {
                    ...settings.integrations,
                    musicbrainz: {
                      ...(settings.integrations?.musicbrainz || {}),
                      email: e.target.value,
                    },
                  },
                })
              }
            />
            <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
              Required by MusicBrainz API to identify the application.
            </p>
            </div>
          </fieldset>
        </div>
        <div
          className="p-6 rounded-lg space-y-4"
          style={{
            backgroundColor: "#1a1a1e",
            border: "1px solid #2a2a2e",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3
              className="text-lg font-medium flex items-center"
              style={{ color: "#fff" }}
            >
              Last.fm API
            </h3>
            <div className="flex items-center gap-2">
              {health?.lastfmConfigured && (
                <span className="flex items-center text-sm text-green-400">
                  <CheckCircle className="w-4 h-4 mr-1" />
                  Configured
                </span>
              )}
              <button
                type="button"
                className={`btn ${
                  lastfmEditing ? "btn-primary" : "btn-secondary"
                } px-2 py-1`}
                onClick={() => setLastfmEditing((value) => !value)}
                aria-label={
                  lastfmEditing ? "Lock Last.fm settings" : "Edit Last.fm settings"
                }
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>
          </div>
          <fieldset
            disabled={!lastfmEditing}
            className={`space-y-4 ${lastfmEditing ? "" : "opacity-60"}`}
          >
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                API Key
              </label>
              <input
                type="password"
                className="input"
                placeholder={settings.integrations?.lastfm?.secretIsSet ? "API Key has been set, enter to change" : "Enter Last.fm API Key"}
                autoComplete="off"
                value={""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      lastfm: {
                        ...(settings.integrations?.lastfm || {}),
                        apiKey: e.target.value,
                      },
                    },
                  })
                }
              />
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Username
              </label>
              <input
                type="text"
                className="input"
                placeholder="Your Last.fm username"
                autoComplete="off"
                value={settings.integrations?.lastfm?.username || ""}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      lastfm: {
                        ...(settings.integrations?.lastfm || {}),
                        username: e.target.value,
                      },
                    },
                  })
                }
              />
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Your Last.fm username for personalized recommendations based on
                your listening history.
              </p>
            </div>
            <div>
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: "#fff" }}
              >
                Discovery period
              </label>
              <select
                className="input"
                value={
                  settings.integrations?.lastfm?.discoveryPeriod || "1month"
                }
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    integrations: {
                      ...settings.integrations,
                      lastfm: {
                        ...(settings.integrations?.lastfm || {}),
                        discoveryPeriod: e.target.value,
                      },
                    },
                  })
                }
              >
                <option value="none">None (Library only)</option>
                <option value="7day">Last 7 days</option>
                <option value="1month">This month</option>
                <option value="3month">3 months</option>
                <option value="6month">6 months</option>
                <option value="12month">12 months</option>
                <option value="overall">All time</option>
              </select>
              <p className="mt-1 text-xs" style={{ color: "#c1c1c3" }}>
                Which Last.fm listening period to use for discovery seeds.
              </p>
            </div>
            <p className="text-xs" style={{ color: "#c1c1c3" }}>
              API key is required for high-quality images, better recommendations,
              and weekly flow. Username enables personalized recommendations from
              your Last.fm listening history.
            </p>
          </fieldset>
        </div>
      </form>
    </div>
  );
}
