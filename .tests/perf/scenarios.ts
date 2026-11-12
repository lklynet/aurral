import { allReleaseTypes } from "../../frontend/src/pages/ArtistDetails/constants.ts";

export type PerfContext = {
  artistId: number;
  albumId: number;
  trackId: number;
  lastAlbumPage: number;
  playlistId: string;
  editPlaylist: { id: string; songIds: string[][] };
};

const library = (params: Record<string, string | number | boolean>) =>
  `/api/library?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`;

const homeRails = ["plays", "random", "newest", "played", "released"].map((sort) =>
  library({
    kind: "albums",
    page: 1,
    pageSize: 20,
    sort,
    ...((sort === "random" || sort === "released") && { availableOnly: true }),
  }),
);

export type Scenario = {
  name: string;
  random?: true;
  writes?: true;
  requests: (context: PerfContext) => string[];
};

const DISCOVER_ARTIST = "90000000-0000-4000-8000-000000000001";
const DISCOVER_ALBUM = "90000000-0000-4000-8000-000000000002";
const SIMILAR_ARTIST = "90000000-0000-4000-8000-000000000003";

let playlistEdits = 0;

export const scenarios: Scenario[] = [
  { name: "app shell", requests: () => ["/api/health/bootstrap", "/api/auth/me"] },
  {
    name: "library home",
    random: true,
    requests: () => [
      ...homeRails,
      library({ kind: "tracks", page: 1, pageSize: 12, sort: "newest", availableOnly: true }),
    ],
  },
  {
    name: "library albums",
    requests: () => [library({ kind: "albums", page: 1, pageSize: 100, sort: "name" })],
  },
  {
    name: "library albums, last page",
    requests: ({ lastAlbumPage }) => [
      library({ kind: "albums", page: lastAlbumPage, pageSize: 100, sort: "name" }),
    ],
  },
  {
    name: "library albums, recently added",
    requests: () => [library({ kind: "albums", page: 1, pageSize: 100, sort: "newest" })],
  },
  {
    name: "library artists",
    requests: () => [library({ kind: "artists", page: 1, pageSize: 100, sort: "name" })],
  },
  {
    name: "library tracks",
    requests: () => [
      library({ kind: "tracks", page: 1, pageSize: 100, sort: "name", availableOnly: true }),
    ],
  },
  { name: "library genres", requests: () => [library({ kind: "genres", page: 1, pageSize: 100 })] },
  {
    name: "library genre filter",
    requests: () => [library({ kind: "albums", page: 1, pageSize: 100, genre: "Jazz" })],
  },
  {
    name: "library status filter",
    requests: () => [
      library({ kind: "albums", page: 1, pageSize: 100, status: "missing" }),
      library({ kind: "artists", page: 1, pageSize: 100, status: "missing" }),
    ],
  },
  {
    name: "library filter",
    requests: () => [library({ kind: "albums", page: 1, pageSize: 100, query: "Album 0004" })],
  },
  {
    name: "artist page",
    requests: ({ artistId }) => [
      library({ kind: "albums", artistId, page: 1, pageSize: 100 }),
      library({ kind: "tracks", artistId, page: 1, pageSize: 100, availableOnly: true }),
      library({
        kind: "tracks",
        artistId,
        page: 1,
        pageSize: 10,
        sort: "plays",
        availableOnly: true,
      }),
      `/api/library/artists/${artistId}/plays`,
    ],
  },
  {
    name: "album page",
    requests: ({ albumId }) => [
      library({ kind: "tracks", albumId, page: 1, pageSize: 100, availableOnly: false }),
    ],
  },
  { name: "favorites", requests: () => ["/api/library/favorites"] },
  { name: "search", requests: () => ["/api/search/library?q=perf%20track%20001&limit=20"] },
  { name: "discover recently added", requests: () => ["/api/library/recent"] },
  {
    name: "discover artist",
    requests: () => [
      `/api/artists/${DISCOVER_ARTIST}?${new URLSearchParams({ mode: "core", releaseTypes: allReleaseTypes.join(",") })}`,
      `/api/artists/${DISCOVER_ARTIST}/cover`,
      `/api/artists/${DISCOVER_ARTIST}/similar?limit=10`,
      `/api/artists/${DISCOVER_ARTIST}/playlists`,
      `/api/artists/${DISCOVER_ARTIST}/shows`,
      `/api/artists/${DISCOVER_ARTIST}/listening?artistName=${encodeURIComponent("Perf Artist 00001")}`,
      `/api/library/lookup/${DISCOVER_ARTIST}`,
    ],
  },
  { name: "discover album", requests: () => [`/api/artists/release-group/${DISCOVER_ALBUM}`] },
  {
    name: "discover album tracks",
    requests: () => [
      `/api/artists/release-group/${DISCOVER_ALBUM}/tracks`,
      `/api/artists/release-group/${DISCOVER_ALBUM}/previews`,
    ],
  },
  { name: "discover search", requests: () => ["/api/search?q=perf&scope=artist"] },
  { name: "similar artists", requests: () => [`/api/artists/${SIMILAR_ARTIST}/similar`] },
  { name: "playlists", requests: () => ["/api/playlists/status"] },
  {
    name: "activity queue",
    requests: () => [
      "/api/requests/page?view=queue&limit=25&refresh=1",
      "/api/requests/page?view=queue&status=review&limit=25",
    ],
  },
  { name: "listening history", requests: () => ["/api/users/me/listening-history"] },
  { name: "subsonic getArtists", requests: () => ["/rest/getArtists"] },
  {
    name: "subsonic getAlbumList2",
    requests: () => [
      "/rest/getAlbumList2?type=alphabeticalByName&size=100",
      "/rest/getAlbumList2?type=newest&size=100",
      "/rest/getAlbumList2?type=frequent&size=100",
    ],
  },
  {
    name: "subsonic getArtist",
    requests: ({ artistId }) => [`/rest/getArtist?id=artist:perf:artist:${artistId - 1}`],
  },
  {
    name: "subsonic getAlbum",
    requests: ({ albumId }) => [`/rest/getAlbum?id=album:perf:album:${albumId - 1}`],
  },
  {
    name: "subsonic search3",
    requests: () => [
      "/rest/search3?query=Perf%20Track%20001&artistCount=20&albumCount=20&songCount=50",
    ],
  },
  { name: "subsonic getStarred2", requests: () => ["/rest/getStarred2"] },
  {
    name: "subsonic getRandomSongs",
    random: true,
    requests: () => ["/rest/getRandomSongs?size=50"],
  },
  { name: "subsonic getGenres", requests: () => ["/rest/getGenres"] },
  {
    name: "subsonic getSongsByGenre",
    requests: () => ["/rest/getSongsByGenre?genre=Rock&count=100"],
  },
  {
    name: "subsonic playlists",
    requests: ({ playlistId }) => [
      "/rest/getPlaylists",
      `/rest/getPlaylist?id=${encodeURIComponent(playlistId)}`,
    ],
  },
  {
    name: "subsonic edit playlist",
    writes: true,
    requests: ({ editPlaylist }) => {
      const songIds = editPlaylist.songIds[playlistEdits++];
      if (!songIds) throw new Error("subsonic edit playlist ran out of unlinked songs");
      const songs = songIds.map((id) => `&songId=${encodeURIComponent(id)}`).join("");
      return [`/rest/createPlaylist?playlistId=${encodeURIComponent(editPlaylist.id)}${songs}`];
    },
  },
  {
    name: "album match",
    requests: ({ albumId }) => [`/api/library/albums/${albumId}/matches`],
  },
  {
    name: "track match",
    requests: ({ trackId }) => [`/api/library/tracks/${trackId}/matches`],
  },
  {
    name: "artist match",
    requests: ({ artistId }) => [`/api/library/artists/${artistId}/matches`],
  },
];
