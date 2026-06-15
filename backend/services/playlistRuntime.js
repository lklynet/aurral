import path from "path";
import {
  PLAYLIST_LIBRARY_DIR,
  resolvePlaylistRoot,
} from "./playlistPaths.js";

export async function refreshPlaylistRuntimeRoots() {
  const root = resolvePlaylistRoot();
  const [{ weeklyFlowWorker }, { playlistManager }] = await Promise.all([
    import("./weeklyFlowWorker.js"),
    import("./weeklyFlowPlaylistManager.js"),
  ]);
  weeklyFlowWorker.weeklyFlowRoot = root;
  playlistManager.weeklyFlowRoot = root;
  playlistManager.playlistLibraryRoot = path.join(root, PLAYLIST_LIBRARY_DIR);
  playlistManager.libraryRoot = path.join(
    playlistManager.playlistLibraryRoot,
    "_playlists",
  );
  return root;
}
