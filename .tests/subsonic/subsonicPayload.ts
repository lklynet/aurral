export type SubsonicEntry = {
  id: string;
  name: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artistId: string;
  created: string;
  coverArt: string;
  starred: string;
  genre: string;
  musicBrainzId: string;
  artistImageUrl: string;
  roles: string[];
  [key: string]: unknown;
};
type SubsonicPlaylist = SubsonicEntry & { changed: string; entry: SubsonicEntry[] };
type Starred = { song: SubsonicEntry[]; artist: SubsonicEntry[]; album: SubsonicEntry[] };
export type SubsonicPayload = {
  version: string;
  type: string;
  serverVersion: string;
  openSubsonic: boolean;
  openSubsonicExtensions: { name: string; versions: number[] }[];
  status: string;
  error: { code: number; message: string; helpUrl?: string };
  playlist: SubsonicPlaylist;
  playlists: { playlist: SubsonicPlaylist[] };
  artists: { ignoredArticles: string; index: { name: string; artist: SubsonicEntry[] }[] };
  indexes: { lastModified: number; index: { name: string; artist: SubsonicEntry[] }[] };
  starred: Starred;
  starred2: Starred;
  searchResult3: Starred;
  randomSongs: { song: SubsonicEntry[] };
  topSongs: { song: SubsonicEntry[] };
  playQueueByIndex: { entry: SubsonicEntry[]; currentIndex: number; position: number };
  nowPlaying: { entry: (SubsonicEntry & { username: string })[] };
  playQueue: {
    entry: SubsonicEntry[];
    current: string;
    position: number;
    username: string;
    changedBy: string;
    changed: string;
  };
  album: SubsonicEntry & { song: SubsonicEntry[] };
  artist: SubsonicEntry & { album: SubsonicEntry[] };
  song: SubsonicEntry;
  user: { username: string; adminRole: boolean; streamRole: boolean };
  license: { valid: boolean };
  albumList2: { album: SubsonicEntry[] };
  songsByGenre: { song: SubsonicEntry[] };
  genres: { genre: { albumCount: number; songCount: number; value: string }[] };
  artistInfo: { similarArtist: SubsonicEntry[] };
  artistInfo2: { similarArtist: SubsonicEntry[]; largeImageUrl: string };
  lyrics: { value: string };
  lyricsList: {
    structuredLyrics: {
      lang: string;
      synced: boolean;
      line: { value: string; start?: number }[];
    }[];
  };
  [key: string]: unknown;
};

export type SubsonicResponse = { "subsonic-response": SubsonicPayload };

export function subsonicPayload(body: string) {
  return (JSON.parse(body) as SubsonicResponse)["subsonic-response"];
}
