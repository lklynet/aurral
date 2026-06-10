import express from "express";
import registerReleaseGroup from "./handlers/releaseGroup.js";
import registerStream from "./handlers/stream.js";
import registerPreview from "./handlers/preview.js";
import registerDetails from "./handlers/details.js";
import registerCover from "./handlers/cover.js";
import registerSimilar from "./handlers/similar.js";
import registerVideo from "./handlers/video.js";

const router = express.Router();
registerReleaseGroup(router);
registerStream(router);
registerPreview(router);
registerDetails(router);
registerCover(router);
registerSimilar(router);
registerVideo(router);

export default router;
