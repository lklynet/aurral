import express from "express";
import { requireAuth, requirePermission } from "../../middleware/requirePermission.ts";
import { registerArtworkServe } from "./handlers/artworkServe.ts";
import { registerArtworkManagement } from "./handlers/artworkManagement.ts";
import { registerFlows } from "./handlers/flows.ts";
import { registerStaticPlaylists } from "./handlers/staticPlaylists.ts";
import { registerSpotifyImport } from "./handlers/spotifyImport.ts";
import { registerListenBrainzImport } from "./handlers/listenbrainzImport.ts";
import { registerLastfmImport } from "./handlers/lastfmImport.ts";
import { registerYoutubeMusicImport } from "./handlers/youtubeMusicImport.ts";
import { registerJobs, registerJobCancellation } from "./handlers/jobs.ts";
import {
  registerTrackArtworkManagement,
  registerTrackArtworkServe,
} from "./handlers/trackArtwork.ts";

const router = express.Router();

registerArtworkServe(router);
registerTrackArtworkServe(router);

router.use(requireAuth);
registerJobCancellation(router);
router.use(requirePermission("accessFlow"));

registerArtworkManagement(router);
registerTrackArtworkManagement(router);
registerFlows(router);
registerStaticPlaylists(router);
registerSpotifyImport(router);
registerListenBrainzImport(router);
registerLastfmImport(router);
registerYoutubeMusicImport(router);
registerJobs(router);

export default router;
