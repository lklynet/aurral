type Song = { id: string; title: string; artist: string; album?: string; duration?: number };
type Scrobble = { id: number; mediaFileId: string; submissionTime: number };

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

export function createFakeNavidrome({
  password = "password",
  songs = [],
  scrobbles = [],
  playlists = [],
}: {
  password?: string;
  songs?: Song[];
  scrobbles?: Scrobble[];
  playlists?: string[];
} = {}) {
  const state = { songs, scrobbles, playlists, fetch: fetchResponse };

  async function fetchResponse(input: Parameters<typeof fetch>[0], init: RequestInit = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const params = url.searchParams;
    if (url.pathname === "/auth/login") {
      const body: unknown = JSON.parse(String(init.body ?? "{}"));
      const valid =
        typeof body === "object" && body && "password" in body && body.password === password;
      return valid ? json({ token: "native-token" }) : json({ error: "Invalid credentials" }, 401);
    }
    if (url.pathname === "/api/scrobble") {
      const from = Number(params.get("from")) * 1000;
      const to = Number(params.get("to")) * 1000;
      const rows = state.scrobbles.filter(
        (row) => row.submissionTime * 1000 >= from && row.submissionTime * 1000 <= to,
      );
      return json(rows.slice(Number(params.get("_start")), Number(params.get("_end"))));
    }
    if (url.pathname === "/api/song") {
      const ids = new Set(params.getAll("id"));
      return json(state.songs.filter((song) => ids.has(song.id)));
    }
    if (url.pathname.replace(/\.view$/, "") === "/rest/deletePlaylist") {
      const id = params.get("id") ?? "";
      if (!state.playlists.includes(id)) {
        return json({ "subsonic-response": { status: "failed", error: { code: 70 } } });
      }
      state.playlists = state.playlists.filter((playlist) => playlist !== id);
      return json({ "subsonic-response": { status: "ok" } });
    }
    return json({ error: "not found" }, 404);
  }

  return state;
}
