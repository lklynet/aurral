import { createServer, type ServerResponse } from "node:http";
import { loadCatalogue } from "../catalogue/catalogue.ts";
import { searchAlbums, searchArtists } from "./search.ts";

const catalogue = loadCatalogue();
const port = Number(process.env.PORT || 5002);

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

const limitOf = (params: URLSearchParams, fallback: number) => {
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : fallback;
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://eden");
  const [, kind, id] = /^.*\/(artist|album)\/([0-9a-f-]{36})$/.exec(url.pathname) ?? [];
  const entity =
    kind === "artist" ? catalogue.artists.get(id ?? "") : catalogue.albums.get(id ?? "");
  if (entity) return send(response, 200, entity);
  if (kind) {
    console.log(`not in the Eden catalogue: ${kind} ${id}`);
    return send(response, 404, { error: "Not in the Eden catalogue" });
  }

  const query = url.searchParams.get("query") ?? "";
  if (url.pathname.endsWith("/search/artist")) {
    return send(response, 200, searchArtists(catalogue, query, limitOf(url.searchParams, 24)));
  }
  if (url.pathname.endsWith("/search/album")) {
    const artist = url.searchParams.get("artist") ?? "";
    return send(
      response,
      200,
      searchAlbums(catalogue, query, artist, limitOf(url.searchParams, 24)),
    );
  }
  if (url.pathname === "/health") {
    return send(response, 200, { artists: catalogue.artists.size, albums: catalogue.albums.size });
  }
  send(response, 404, { error: "Unknown path" });
}).listen(port, () => {
  console.log(
    `Eden metadata: ${catalogue.artists.size} artists, ${catalogue.albums.size} albums on :${port}`,
  );
});
