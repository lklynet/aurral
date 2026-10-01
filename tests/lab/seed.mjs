import fs from "node:fs";
import path from "node:path";
import { writeTrack } from "./services/runtime.mjs";

const PLAYBACK_ARTIST = "Lab Playback Artist";
const PLAYBACK_ALBUM = "Lab Playback Album";
const PLAYBACK_TRACKS = [
  ["Lab Tone One", 440],
  ["Lab Tone Two", 660],
];

const dataDir = process.env.AURRAL_DATA_DIR;
const mediaRoot = process.env.AURRAL_LAB_MEDIA_ROOT;
const username = process.env.AUTH_USER;
const password = process.env.AUTH_PASSWORD;

if (!dataDir || !mediaRoot || !username || !password) {
  console.error("AURRAL_DATA_DIR, AURRAL_LAB_MEDIA_ROOT, AUTH_USER, and AUTH_PASSWORD are required.");
  process.exit(1);
}
const libraryRoot = path.join(mediaRoot, "downloads", "aurral");
const lidarrRoot = path.join(mediaRoot, "lidarr");
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
  downloadFolderPath: libraryRoot,
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
      rootFolderPath: lidarrRoot,
      rootFolderPaths: [lidarrRoot],
      qualityProfileId: 1,
      metadataProfileId: 1,
    },
    slskd: {
      ...settings.integrations?.slskd,
      enabled: true,
      url: process.env.AURRAL_LAB_SLSKD_URL,
      apiKey: process.env.AURRAL_LAB_SLSKD_API_KEY,
    },
  },
  security: { ...settings.security, localNetworkBypass: { enabled: false } },
});
userOps.createUser(username, hashPassword(password), "admin", null, true, true, password);

const { scanConfiguredLibrary } = await backend("services/libraryIndexService.js");
fs.mkdirSync(lidarrRoot, { recursive: true });
const albumDir = path.join(libraryRoot, PLAYBACK_ARTIST, PLAYBACK_ALBUM);
for (const [index, [title, frequency]] of PLAYBACK_TRACKS.entries()) {
  writeTrack(path.join(albumDir, `${String(index + 1).padStart(2, "0")} - ${title}.flac`), {
    artist: PLAYBACK_ARTIST,
    album: PLAYBACK_ALBUM,
    title,
    trackNumber: index + 1,
    durationSeconds: 2,
    frequency,
  });
}
await scanConfiguredLibrary({ musicRoot: libraryRoot, includeLidarr: false });
db.close();
process.exit(0);
