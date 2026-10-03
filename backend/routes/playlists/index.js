import express from "express";
import { requireAuth, requirePermission } from "../../middleware/requirePermission.js";
import { registerStream } from "./handlers/stream.js";
import { registerArtworkServe } from "./handlers/artworkServe.js";
import { registerArtworkManagement } from "./handlers/artworkManagement.js";
import { registerFlows } from "./handlers/flows.js";
import { registerStaticPlaylists } from "./handlers/staticPlaylists.js";
import { registerSpotifyImport } from "./handlers/spotifyImport.js";
import { registerListenBrainzImport } from "./handlers/listenbrainzImport.js";
import { registerLastfmImport } from "./handlers/lastfmImport.js";
import { registerYoutubeMusicImport } from "./handlers/youtubeMusicImport.js";
import { registerJobs } from "./handlers/jobs.js";

const router = express.Router();

registerStream(router);
registerArtworkServe(router);

router.use(requireAuth);
router.use(requirePermission("accessFlow"));

registerArtworkManagement(router);
registerFlows(router);
registerStaticPlaylists(router);
registerSpotifyImport(router);
registerListenBrainzImport(router);
registerLastfmImport(router);
registerYoutubeMusicImport(router);
registerJobs(router);

export default router;
