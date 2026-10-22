import { registerAdmin } from "./handlers/admin.ts";
import { registerMain } from "./handlers/main.ts";
import { registerTags } from "./handlers/tags.ts";
import { registerFeedback } from "./handlers/feedback.ts";
import { registerEditorial } from "./handlers/editorial.ts";
import { registerShows } from "./handlers/shows.ts";
import { registerPreferences } from "./handlers/preferences.ts";
import mountRoutes from "../shared/mountRoutes.ts";

export default mountRoutes([
  registerAdmin,
  registerMain,
  registerTags,
  registerFeedback,
  registerEditorial,
  registerShows,
  registerPreferences,
]);
