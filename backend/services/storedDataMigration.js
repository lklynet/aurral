import { db } from "../config/db-sqlite.js";
import { DEFAULT_METADATA_BASE_URL } from "../config/constants.js";
import { dbOps } from "../db/helpers/index.js";
import { migrateLegacyAdmin } from "../middleware/auth.js";
import { normalizeExistingFileMode } from "./downloadJobs/fileReuseMode.js";
import { STORED_DATA_MIGRATION_SETTING, STORED_DATA_MIGRATION_VERSION } from "./honkerDb.js";
import { flowPlaylistConfig } from "./playlists/flowPlaylistConfig.js";

const RENAMED_SETTING_KEYS = [
  ["weeklyFlows", "flows"],
  ["sharedFlowPlaylists", "sharedPlaylists"],
  ["weeklyFlowWorker", "playlistWorker"],
];
const RETIRED_METADATA_BASE_URL = "https://brainzmash.kell.ly";

const parseJson = (value) => {
  try {
    return value == null ? null : JSON.parse(value);
  } catch {
    return null;
  }
};

function moveRenamedSettingKeys() {
  const read = db.prepare("SELECT value FROM settings WHERE key = ?");
  const write = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  const remove = db.prepare("DELETE FROM settings WHERE key = ?");
  db.transaction(() => {
    for (const [oldKey, key] of RENAMED_SETTING_KEYS) {
      const old = read.get(oldKey);
      if (!old) continue;
      if (parseJson(read.get(key)?.value) == null && parseJson(old.value) != null) {
        write.run(key, old.value);
      }
      remove.run(oldKey);
    }
  })();
  dbOps.invalidateSettingsCache();
}

function storeExistingFileMode() {
  const stored = parseJson(
    db.prepare("SELECT value FROM settings WHERE key = 'playlistWorker'").get()?.value,
  );
  const mode = stored?.existingFileMode;
  if (mode == null || mode === normalizeExistingFileMode(mode)) return;
  dbOps.updateSettings({ playlistWorker: dbOps.getSettings().playlistWorker });
}

function storeCurrentIntegrations() {
  const settings = dbOps.getSettings();
  const integrations = { ...(settings.integrations || {}) };
  let changed = false;

  if ("coverArtArchive" in integrations) {
    delete integrations.coverArtArchive;
    changed = true;
  }
  if (integrations.musicbrainz && "customUrl" in integrations.musicbrainz) {
    const { customUrl: _customUrl, ...musicbrainz } = integrations.musicbrainz;
    integrations.musicbrainz = musicbrainz;
    changed = true;
  }
  const navidrome = integrations.navidrome;
  if (navidrome && ("m3uPathMode" in navidrome || "pathMappings" in navidrome)) {
    changed = true;
  }
  const baseUrl = String(integrations.metadata?.baseUrl || "").trim().replace(/\/+$/, "");
  if (baseUrl === RETIRED_METADATA_BASE_URL) {
    integrations.metadata = { ...integrations.metadata, baseUrl: DEFAULT_METADATA_BASE_URL };
    changed = true;
  }
  let artworkStyle = null;
  if (integrations.lastfm && "discoverFlowArtworkStyle" in integrations.lastfm) {
    const { discoverFlowArtworkStyle, ...lastfm } = integrations.lastfm;
    integrations.lastfm = lastfm;
    if (discoverFlowArtworkStyle === "aurral") artworkStyle = "aurral";
    changed = true;
  }

  if (changed) dbOps.updateSettings({ integrations });
  if (artworkStyle && settings.playlistArtwork?.style !== artworkStyle) {
    dbOps.updateSettings({ playlistArtwork: { ...settings.playlistArtwork, style: artworkStyle } });
  }
}

export function migrateStoredData() {
  moveRenamedSettingKeys();
  flowPlaylistConfig.saveNormalizedFlows();
  storeExistingFileMode();
  storeCurrentIntegrations();
  migrateLegacyAdmin();
  dbOps.setJSONSetting(STORED_DATA_MIGRATION_SETTING, {
    version: STORED_DATA_MIGRATION_VERSION,
    completedAt: Date.now(),
  });
}
