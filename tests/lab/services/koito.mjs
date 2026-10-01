export function createKoito(catalog, { token }) {
  const state = { listens: [] };
  const topArtists = catalog.artists.map((artist, index) => ({
    item: { id: index + 1, name: artist.name, musicbrainz_id: artist.id, listen_count: 120 - index * 11 },
  }));

  const handler = ({ method, url, headers, body }) => {
    if (method === "GET" && url.pathname === "/apis/web/v1/top/artists") {
      const limit = Number(url.searchParams.get("limit")) || 20;
      const page = Number(url.searchParams.get("page")) || 1;
      const items = topArtists.slice((page - 1) * limit, page * limit);
      return { status: 200, body: { items, has_next_page: page * limit < topArtists.length, current_page: page } };
    }
    if (!url.pathname.startsWith("/apis/listenbrainz/1/")) return null;
    const authorized = String(headers.authorization || "") === `Token ${token}`;
    if (method === "GET" && url.pathname.endsWith("/validate-token")) {
      return { status: 200, body: authorized ? { code: 200, message: "Token valid.", valid: true, user_name: "lab-koito" } : { code: 200, message: "Token invalid.", valid: false } };
    }
    if (method === "POST" && url.pathname.endsWith("/submit-listens")) {
      if (!authorized) return { status: 401, body: { code: 401, error: "Invalid authorization token." } };
      for (const listen of body?.payload || []) state.listens.push({ type: body.listen_type, ...listen });
      return { status: 200, body: { status: "ok" } };
    }
    return null;
  };
  handler.state = state;
  handler.restore = (saved) => Object.assign(state, saved);
  return handler;
}
