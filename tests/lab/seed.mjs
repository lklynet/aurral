import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PLAYBACK_ARTIST = "Lab Playback Artist";
const PLAYBACK_ALBUM = "Lab Playback Album";
const PLAYBACK_TRACKS = [
  ["Lab Tone One", 440],
  ["Lab Tone Two", 660],
];

const dataDir = process.env.AURRAL_DATA_DIR;
const username = process.env.AUTH_USER;
const password = process.env.AUTH_PASSWORD;

if (!dataDir || !username || !password) {
  console.error("AURRAL_DATA_DIR, AUTH_USER, and AUTH_PASSWORD are required.");
  process.exit(1);
}
process.env.AURRAL_DB_PATH = path.join(dataDir, "aurral.db");
if (fs.existsSync(process.env.AURRAL_DB_PATH)) {
  console.error(`${dataDir} already contains an Aurral database. Seed only empty Lab state.`);
  process.exit(1);
}

const backend = (file) => import(new URL(`../../backend/${file}`, import.meta.url));
const { db } = await backend("config/db-sqlite.js");
const { dbOps, userOps } = await backend("db/helpers/index.js");
const { hashPassword } = await backend("middleware/passwordHash.js");

const settings = dbOps.getSettings();
dbOps.updateSettings({
  ...settings,
  onboardingComplete: true,
  integrations: {
    ...settings.integrations,
    general: { ...settings.integrations?.general, authUser: username, authPassword: password },
    metadata: {
      ...settings.integrations?.metadata,
      baseUrl: process.env.AURRAL_LAB_METADATA_URL,
      enableNarrowFallbacks: false,
    },
    lidarr: {
      ...settings.integrations?.lidarr,
      url: process.env.AURRAL_LAB_LIDARR_URL,
      apiKey: process.env.AURRAL_LAB_LIDARR_API_KEY,
      rootFolderPath: "/music",
      rootFolderPaths: ["/music"],
      qualityProfileId: 1,
      metadataProfileId: 1,
    },
  },
  security: { ...settings.security, localNetworkBypass: { enabled: false } },
});
userOps.createUser(username, hashPassword(password), "admin", null, true, true, password);

const { resolvePlaylistRoot } = await backend("services/playlistPaths.js");
const { scanConfiguredLibrary } = await backend("services/libraryIndexService.js");
const albumDir = path.join(resolvePlaylistRoot(), PLAYBACK_ARTIST, PLAYBACK_ALBUM);
fs.mkdirSync(albumDir, { recursive: true });
for (const [index, [title, frequency]] of PLAYBACK_TRACKS.entries()) {
  const target = path.join(albumDir, `${String(index + 1).padStart(2, "0")} - ${title}.flac`);
  const encoded = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=2`,
    "-ac", "1", "-ar", "8000",
    "-metadata", `artist=${PLAYBACK_ARTIST}`, "-metadata", `album_artist=${PLAYBACK_ARTIST}`,
    "-metadata", `album=${PLAYBACK_ALBUM}`, "-metadata", `title=${title}`, "-metadata", `track=${index + 1}`,
    target,
  ], { encoding: "utf8" });
  if (encoded.status !== 0) {
    console.error(`Could not create ${target} with ffmpeg: ${encoded.error?.message || encoded.stderr}`);
    process.exit(1);
  }
}
await scanConfiguredLibrary({ includeLidarr: false });
db.close();
process.exit(0);
