import { Hono } from "hono";
import type { AppEnv } from "../../middleware/requestUser.ts";
import appearsOn from "./handlers/appearsOn.ts";
import cover from "./handlers/cover.ts";
import details from "./handlers/details.ts";
import preview from "./handlers/preview.ts";
import releaseGroup from "./handlers/releaseGroup.ts";
import similar from "./handlers/similar.ts";
import video from "./handlers/video.ts";

export default new Hono<AppEnv>()
  .route("/", releaseGroup)
  .route("/", preview)
  .route("/", details)
  .route("/", cover)
  .route("/", similar)
  .route("/", video)
  .route("/", appearsOn);
