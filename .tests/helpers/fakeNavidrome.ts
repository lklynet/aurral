type SongFixture = {
  id: string;
  path: string;
  title?: string;
  artist?: string;
  album?: string;
  missing?: boolean;
  libraryPath?: string;
  mbzRecordingID?: string;
  [key: string]: unknown;
};

const jsonResponse = (value: unknown, status: number = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const listResponse = (items: unknown[]) =>
  new Response(JSON.stringify(items), {
    headers: { "content-type": "application/json", "x-total-count": String(items.length) },
  });

const subsonicResponse = (value: Record<string, unknown> = {}) =>
  jsonResponse({
    "subsonic-response": { status: "ok", ...value },
  });

function startsWithLike(value: string) {
  const pattern = String(value)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${pattern}`, "i");
}

function matchesSongFilters(song: SongFixture, params: URLSearchParams) {
  for (const [key, value] of params) {
    if (key === "missing" && Boolean(song.missing) !== (value === "true")) return false;
    if (key === "path" && !startsWithLike(value).test(song.path)) return false;
    if (key === "mbz_recording_id" && song.mbzRecordingID !== value) return false;
    if (key === "title") {
      const text = `${song.title} ${song.artist} ${song.album}`.toLowerCase();
      const words = value.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.some((word: string) => word.replace(/\*$/, "").includes("*"))) return false;
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
}: {
  libraries?: { id: number; path: string; name?: string }[];
  songs?: SongFixture[];
  playlists?: { id: string; name: string | null; songIds?: string[]; comment?: string }[];
  serverVersion?: string;
  failSongRequest?: (params: URLSearchParams) => boolean;
  failLibraryRequest?: boolean;
} = {}) {
  const state = {
    libraries,
    songs,
    serverVersion,
    playlists: playlists.map((playlist) => ({ songIds: [], ...playlist })),
    songRequests: [] as URLSearchParams[],
    scans: [] as string[][],
    logins: 0,
    fetch: fetchResponse,
  };
  let nextPlaylistId = 1;

  const playlistDetail = (playlist: {
    id: string;
    name: string | null;
    songIds: string[];
    comment?: string;
  }) => ({
    id: playlist.id,
    name: playlist.name,
    ...(playlist.comment === undefined ? {} : { comment: playlist.comment }),
    songCount: playlist.songIds.length,
    entry: playlist.songIds.map((id) => ({ id })),
  });

  async function fetchResponse(
    input: Parameters<typeof fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
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
    if (url.pathname === "/api/playlist" && method === "GET") {
      return listResponse(
        state.playlists.map(({ id, name, songIds }) => ({ id, name, songCount: songIds.length })),
      );
    }
    const playlistTracks = /^\/api\/playlist\/([^/]+)\/tracks$/.exec(url.pathname);
    if (playlistTracks && method === "GET") {
      const playlist = state.playlists.find(
        (candidate) => candidate.id === decodeURIComponent(playlistTracks[1]),
      );
      if (!playlist) return jsonResponse({ error: "not found" }, 404);
      return listResponse(
        playlist.songIds.map((songId, index) => ({
          ...state.songs.find((song) => song.id === songId),
          id: String(index + 1),
          mediaFileId: songId,
        })),
      );
    }
    if (url.pathname === "/api/song") {
      state.songRequests.push(url.searchParams);
      if (failSongRequest(url.searchParams)) return jsonResponse({ error: "unavailable" }, 500);
      const start = Number(url.searchParams.get("_start") || 0);
      const end = Number(url.searchParams.get("_end") || state.songs.length);
      return jsonResponse(
        state.songs.filter((song) => matchesSongFilters(song, url.searchParams)).slice(start, end),
      );
    }
    const params = init.body instanceof URLSearchParams ? init.body : url.searchParams;
    switch (url.pathname) {
      case "/rest/ping":
        return subsonicResponse({
          type: "navidrome",
          serverVersion: state.serverVersion,
          openSubsonic: true,
        });
      case "/rest/getUser":
        return subsonicResponse({ user: { username: params.get("username"), adminRole: true } });
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
      case "/rest/deletePlaylist":
        state.playlists = state.playlists.filter((playlist) => playlist.id !== params.get("id"));
        return subsonicResponse();
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
  }

  return state;
}
