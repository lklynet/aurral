import { registerReleaseGroup } from "./handlers/releaseGroup.ts";
import { registerPreview } from "./handlers/preview.ts";
import { registerDetails } from "./handlers/details.ts";
import { registerCover } from "./handlers/cover.ts";
import { registerSimilar } from "./handlers/similar.ts";
import { registerVideo } from "./handlers/video.ts";
import { registerAppearsOn } from "./handlers/appearsOn.ts";
import mountRoutes from "../shared/mountRoutes.ts";

export default mountRoutes([
  registerReleaseGroup,
  registerPreview,
  registerDetails,
  registerCover,
  registerSimilar,
  registerVideo,
  registerAppearsOn,
]);
