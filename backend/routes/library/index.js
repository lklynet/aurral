import express from "express";
import { registerStream } from "./handlers/stream.js";
import { registerArtists } from "./handlers/artists.js";
import { registerAlbums } from "./handlers/albums.js";
import { registerTracks } from "./handlers/tracks.js";
import { registerDownloads } from "./handlers/downloads.js";
import { registerMisc } from "./handlers/misc.js";
import { registerCanonical } from "./handlers/canonical.js";
import { requireAppCapability } from "../../middleware/appProfile.js";

const router = express.Router();

for (const path of [
  "/refresh",
  "/canonical",
  "/favorites",
  "/playback-queue",
  "/tracks",
  "/canonical-stream",
  "/file-stream",
]) {
  router.use(path, requireAppCapability("localLibrary"));
}
router.use("/stream", requireAppCapability("playback"));

registerCanonical(router);
registerStream(router);
registerTracks(router);
registerArtists(router);
registerAlbums(router);
registerDownloads(router);
registerMisc(router);

export default router;
