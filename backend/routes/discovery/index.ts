import { Hono } from "hono";
import type { AppEnv } from "../../middleware/requestUser.ts";
import admin from "./handlers/admin.ts";
import blockedTags from "./handlers/blockedTags.ts";
import editorial from "./handlers/editorial.ts";
import feedback from "./handlers/feedback.ts";
import main from "./handlers/main.ts";
import preferences from "./handlers/preferences.ts";
import shows from "./handlers/shows.ts";
import tags from "./handlers/tags.ts";
import trending from "./handlers/trending.ts";

export default new Hono<AppEnv>()
  .basePath("/discover")
  .route("/", admin)
  .route("/", main)
  .route("/", tags)
  .route("/", feedback)
  .route("/", blockedTags)
  .route("/", editorial)
  .route("/", trending)
  .route("/", shows)
  .route("/", preferences);
