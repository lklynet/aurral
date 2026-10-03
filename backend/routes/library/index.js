import { registerStream } from "./handlers/stream.js";
import { registerArtists } from "./handlers/artists.js";
import { registerAlbums } from "./handlers/albums.js";
import { registerTracks } from "./handlers/tracks.js";
import { registerDownloads } from "./handlers/downloads.js";
import { registerMisc } from "./handlers/misc.js";
import { registerLibraryIndex } from "./handlers/libraryIndex.js";
import mountRoutes from "../shared/mountRoutes.js";

export default mountRoutes([
  registerLibraryIndex,
  registerStream,
  registerArtists,
  registerAlbums,
  registerTracks,
  registerDownloads,
  registerMisc,
]);
