import { registerAdmin } from "./handlers/admin.js";
import { registerMain } from "./handlers/main.js";
import { registerTags } from "./handlers/tags.js";
import { registerFeedback } from "./handlers/feedback.js";
import { registerEditorial } from "./handlers/editorial.js";
import { registerShows } from "./handlers/shows.js";
import { registerPreferences } from "./handlers/preferences.js";
import mountRoutes from "../shared/mountRoutes.js";

export default mountRoutes([
  registerAdmin,
  registerMain,
  registerTags,
  registerFeedback,
  registerEditorial,
  registerShows,
  registerPreferences,
]);
