import { registerStream } from "./handlers/stream.js";
import { registerArtists } from "./handlers/artists.js";
import { registerAlbums } from "./handlers/albums.js";
import { registerTracks } from "./handlers/tracks.js";
import { registerDownloads } from "./handlers/downloads.js";
import { registerMisc } from "./handlers/misc.js";
import { registerLibraryIndex } from "./handlers/libraryIndex.js";
import { registerFiles } from "./handlers/files.js";
import { registerMonitoring } from "./handlers/monitoring.js";
import { registerArtwork } from "./handlers/artwork.js";
import mountRoutes from "../shared/mountRoutes.js";

export default mountRoutes([
  registerLibraryIndex,
  registerArtwork,
  registerStream,
  registerArtists,
  registerMonitoring,
  registerAlbums,
  registerTracks,
  registerDownloads,
  registerMisc,
  registerFiles,
]);
