import { pageOf, type Outside } from "./music.ts";

const NOT_FOUND = undefined;

export const musicbrainz: Outside = {
  hosts: ["musicbrainz.org"],
  respond({ url }, music) {
    const [, entity, id] = /^\/ws\/2\/([\w-]+)(?:\/([\w-]+))?\/?$/.exec(url.pathname) ?? [];
    const query = url.searchParams.get("query") ?? "";
    if (entity === "genre" && id === "all") {
      const genres = music.genres.map((name) => ({ id: name, name }));
      return { "genre-count": genres.length, "genre-offset": 0, genres };
    }
    if (entity === "artist" && id) {
      const artist = music.artistById.get(id);
      return artist ? { id, name: artist.name, "sort-name": artist.name } : NOT_FOUND;
    }
    if (entity === "artist") {
      const [, tag] = /tag:"((?:[^"\\]|\\.)*)"/.exec(query) ?? [];
      const found = tag ? music.inGenre(tag.replace(/\\(.)/g, "$1")) : music.findArtists(query);
      return {
        count: found.length,
        offset: Number(url.searchParams.get("offset")) || 0,
        artists: pageOf(found, url, "limit", "offset").map((artist) => ({
          id: artist.id,
          name: artist.name,
          "sort-name": artist.name,
          score: 100,
          tags: artist.genres.map((name) => ({ name, count: 1 })),
        })),
      };
    }
    if (entity === "release" && id) {
      const tracks = music.releaseCredits.get(id);
      if (!tracks) return NOT_FOUND;
      return {
        id,
        media: [
          {
            tracks: tracks.map(({ recording, id: artistId, name }) => ({
              "artist-credit": [{ name, joinphrase: "", artist: { id: artistId, name } }],
              recording: { id: recording },
            })),
          },
        ],
      };
    }
    if (entity === "release") return { "release-count": 0, "release-offset": 0, releases: [] };
    if (entity === "release-group" && !id) {
      return { "release-group-count": 0, "release-group-offset": 0, "release-groups": [] };
    }
    return NOT_FOUND;
  },
};
