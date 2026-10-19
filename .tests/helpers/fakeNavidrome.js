const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

const subsonicResponse = (value = {}) => jsonResponse({
  "subsonic-response": { status: "ok", ...value },
});

function startsWithLike(value) {
  const pattern = String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${pattern}`, "i");
}

function matchesSongFilters(song, params) {
  for (const [key, value] of params) {
    if (key === "missing" && Boolean(song.missing) !== (value === "true")) return false;
    if (key === "path" && !startsWithLike(value).test(song.path)) return false;
    if (key === "mbz_recording_id" && song.mbzRecordingID !== value) return false;
    if (key === "title") {
      const text = `${song.title} ${song.artist} ${song.album}`.toLowerCase();
      const words = value.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.some((word) => word.replace(/\*$/, "").includes("*"))) return false;
      if (!words.every((word) => text.includes(word))) return false;
    }
  }
  return true;
}

export function createFakeNavidrome({
  libraries = [],
  songs = [],
  playlists = [],
  serverVersion = "0.64.2 (e7c6c4d9)",
  failSongRequest = () => false,
  failLibraryRequest = false,
} = {}) {
  const state = {
    libraries,
    songs,
    serverVersion,
    playlists: playlists.map((playlist) => ({ songIds: [], ...playlist })),
    songRequests: [],
    scans: [],
    logins: 0,
  };
  let nextPlaylistId = 1;

  const playlistDetail = (playlist) => ({
    id: playlist.id,
    name: playlist.name,
    songCount: playlist.songIds.length,
    entry: playlist.songIds.map((id) => ({ id })),
  });

  state.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = String(init.method || "GET").toUpperCase();
    if (url.pathname === "/auth/login") {
      state.logins += 1;
      return jsonResponse({ token: "native-token" });
    }
    if (url.pathname === "/api/library" && method === "GET") {
      return failLibraryRequest
        ? jsonResponse({ error: "forbidden" }, 403)
        : jsonResponse(state.libraries);
    }
    if (url.pathname === "/api/song") {
      state.songRequests.push(url.searchParams);
      if (failSongRequest(url.searchParams)) return jsonResponse({ error: "unavailable" }, 500);
      const start = Number(url.searchParams.get("_start") || 0);
      const end = Number(url.searchParams.get("_end") || state.songs.length);
      return jsonResponse(state.songs
        .filter((song) => matchesSongFilters(song, url.searchParams))
        .slice(start, end));
    }
    const params = init.body instanceof URLSearchParams ? init.body : url.searchParams;
    switch (url.pathname) {
      case "/rest/ping":
        return subsonicResponse({
          type: "navidrome",
          serverVersion: state.serverVersion,
          openSubsonic: true,
        });
      case "/rest/getPlaylists":
        return subsonicResponse({
          playlists: { playlist: state.playlists.map(({ id, name }) => ({ id, name })) },
        });
      case "/rest/getPlaylist": {
        const playlist = state.playlists.find((candidate) => candidate.id === params.get("id"));
        if (!playlist) {
          return jsonResponse({
            "subsonic-response": {
              status: "failed",
              error: { code: 70, message: "Playlist not found" },
            },
          });
        }
        return subsonicResponse({ playlist: playlistDetail(playlist) });
      }
      case "/rest/createPlaylist": {
        const playlist = {
          id: `playlist-${nextPlaylistId++}`,
          name: params.get("name"),
          songIds: params.getAll("songId"),
        };
        state.playlists.push(playlist);
        return subsonicResponse({ playlist: playlistDetail(playlist) });
      }
      case "/rest/startScan":
        state.scans.push(params.getAll("target"));
        return subsonicResponse({ scanStatus: { scanning: true } });
      case "/rest/updatePlaylist": {
        const playlist = state.playlists.find(
          (candidate) => candidate.id === params.get("playlistId"),
        );
        if (!playlist) {
          return jsonResponse({
            "subsonic-response": {
              status: "failed",
              error: { code: 70, message: "Playlist not found" },
            },
          });
        }
        const removed = new Set(params.getAll("songIndexToRemove").map(Number));
        playlist.songIds = playlist.songIds
          .filter((_, index) => !removed.has(index))
          .concat(params.getAll("songIdToAdd"));
        if (params.has("name")) playlist.name = params.get("name");
        return subsonicResponse();
      }
      default:
        return subsonicResponse();
    }
  };

  return state;
}
