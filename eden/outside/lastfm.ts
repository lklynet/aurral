import type { Artist, Music, Outside } from "./music.ts";

const DEFAULT_LIMIT = 50;

const artist = (entry: Artist, index = 0) => ({
  name: entry.name,
  mbid: entry.id,
  url: `https://www.last.fm/music/${encodeURIComponent(entry.name)}`,
  playcount: String(entry.votes * 9000),
  listeners: String(entry.votes * 700),
  match: (1 - index / 25).toFixed(3),
  image: [],
});

const tags = (genres: string[]) => ({
  tag: genres.map((name, index) => ({ name, count: 100 - index * 5, url: "" })),
});

const NOT_FOUND = { error: 6, message: "Eden has nothing by that name" };

export const lastfm: Outside = {
  hosts: ["ws.audioscrobbler.com"],
  respond({ url, body }, music: Music) {
    const params = new URLSearchParams([...new URLSearchParams(body), ...url.searchParams]);
    const limit = Number(params.get("limit")) || DEFAULT_LIMIT;
    const named =
      music.artistById.get(params.get("mbid") ?? "") ?? music.findArtists(params.get("artist"))[0];
    const user = params.get("user") ?? "eden";
    switch (params.get("method")) {
      case "auth.getSession":
        return { session: { name: "eden", key: "eden-session-key", subscriber: 0 } };
      case "track.scrobble":
        return { scrobbles: { "@attr": { accepted: 1, ignored: 0 } } };
      case "artist.getSimilar":
        return named
          ? { similarartists: { artist: music.related(named).slice(0, limit).map(artist) } }
          : NOT_FOUND;
      case "artist.getTopTags":
        return named ? { toptags: tags(named.genres) } : NOT_FOUND;
      case "tag.getTopArtists":
        return {
          topartists: {
            artist: music
              .inGenre(params.get("tag"))
              .slice(0, limit)
              .map((entry) => artist(entry)),
          },
        };
      case "user.getTopArtists":
        return {
          topartists: {
            artist: music.popular
              .slice(0, limit)
              .map((entry, index) => ({ ...artist(entry), playcount: String(500 - index) })),
            "@attr": {
              user,
              page: "1",
              perPage: String(limit),
              totalPages: "1",
              total: String(limit),
            },
          },
        };
      case "user.getRecentTracks": {
        const now = Math.floor(Date.now() / 1000);
        const to = Number(params.get("to")) || now;
        const page = Number(params.get("page")) || 1;
        return {
          recenttracks: {
            track:
              page === 1
                ? music.hits.slice(0, limit).map((entry, index) => ({
                    name: entry.title,
                    mbid: entry.id,
                    artist: { "#text": entry.artist.name, mbid: entry.artist.id },
                    album: { "#text": entry.album.title, mbid: entry.album.id },
                    date: { uts: String(Math.min(to, now) - (index + 1) * 3600) },
                    image: [],
                  }))
                : [],
            "@attr": {
              user,
              page: String(page),
              perPage: String(limit),
              totalPages: "1",
              total: String(limit),
            },
          },
        };
      }
      default:
        return undefined;
    }
  },
};
