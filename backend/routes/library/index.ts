import { Hono } from "hono";
import type { AppEnv } from "../../middleware/requestUser.ts";
import albums from "./handlers/albums.ts";
import artists from "./handlers/artists.ts";
import artwork from "./handlers/artwork.ts";
import downloads from "./handlers/downloads.ts";
import files from "./handlers/files.ts";
import libraryIndex from "./handlers/libraryIndex.ts";
import misc from "./handlers/misc.ts";
import monitoring from "./handlers/monitoring.ts";
import tracks from "./handlers/tracks.ts";

export default new Hono<AppEnv>()
  .route("/", libraryIndex)
  .route("/", artwork)
  .route("/", artists)
  .route("/", monitoring)
  .route("/", albums)
  .route("/", tracks)
  .route("/", downloads)
  .route("/", misc)
  .route("/", files);
