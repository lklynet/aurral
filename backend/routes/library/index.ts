import { registerArtists } from "./handlers/artists.ts";
import { registerAlbums } from "./handlers/albums.ts";
import { registerTracks } from "./handlers/tracks.ts";
import { registerDownloads } from "./handlers/downloads.ts";
import { registerMisc } from "./handlers/misc.ts";
import { registerLibraryIndex } from "./handlers/libraryIndex.ts";
import { registerFiles } from "./handlers/files.ts";
import { registerMonitoring } from "./handlers/monitoring.ts";
import { registerArtwork } from "./handlers/artwork.ts";
import mountRoutes from "../shared/mountRoutes.ts";

export default mountRoutes([
  registerLibraryIndex,
  registerArtwork,
  registerArtists,
  registerMonitoring,
  registerAlbums,
  registerTracks,
  registerDownloads,
  registerMisc,
  registerFiles,
]);
