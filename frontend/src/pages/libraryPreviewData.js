const catalog = [
  {
    artist: "The Night Archive",
    artistId: "preview-artist-night-archive",
    albums: [
      { title: "Static Bloom", year: "2024", genres: ["Indie", "Electronic"] },
      { title: "Afterimage", year: "2022", genres: ["Alternative", "Dream Pop"] },
    ],
  },
  {
    artist: "Mara Vale",
    artistId: "preview-artist-mara-vale",
    albums: [
      { title: "Common Weather", year: "2023", genres: ["Folk", "Singer-Songwriter"] },
      { title: "Small Hours", year: "2020", genres: ["Folk", "Acoustic"] },
    ],
  },
  {
    artist: "Glass District",
    artistId: "preview-artist-glass-district",
    albums: [
      { title: "Soft Machines", year: "2025", genres: ["Post-Punk", "Rock"] },
      { title: "Signal Loss", year: "2021", genres: ["Rock", "Industrial"] },
    ],
  },
  {
    artist: "June Meridian",
    artistId: "preview-artist-june-meridian",
    albums: [
      { title: "Blue Hour", year: "2024", genres: ["Pop", "Soul"] },
      { title: "Open Water", year: "2019", genres: ["Soul", "R&B"] },
    ],
  },
];

const PREVIEW_AUDIO_URL = "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";

const tracksForAlbum = (album, albumIndex) => [
  "Opening Scene",
  "Common Ground",
  "Side Street",
  "Last Light",
].map((title, trackIndex) => ({
  id: `preview-track-${albumIndex + 1}-${trackIndex + 1}`,
  identityKey: `preview-track:${albumIndex + 1}-${trackIndex + 1}`,
  mbid: null,
  title,
  artistName: album.artist,
  metadata: { genres: album.genres },
  albums: [{ albumId: album.id, discNumber: 1, trackNumber: trackIndex + 1 }],
  files: [{
    source: "aurral",
    format: "wav",
    durationMs: 174000 + trackIndex * 11000,
    quality: { bitrate: 320 },
    available: true,
    previewUrl: PREVIEW_AUDIO_URL,
  }],
  sources: ["aurral"],
  available: true,
}));

const albums = catalog.flatMap((artist, artistIndex) =>
  artist.albums.map((album, albumIndex) => ({
    id: `preview-album-${artistIndex + 1}-${albumIndex + 1}`,
    identityKey: `preview-album:${artistIndex + 1}-${albumIndex + 1}`,
    mbid: null,
    releaseGroupMbid: null,
    artistId: artist.artistId,
    title: album.title,
    albumArtist: artist.artist,
    releaseDate: album.year,
    metadata: { genres: album.genres },
    trackIds: [],
    sources: ["aurral"],
    available: true,
  })),
);

const artists = catalog.map((entry) => ({
  id: entry.artistId,
  identityKey: `preview-artist:${entry.artistId}`,
  mbid: null,
  name: entry.artist,
  sortName: entry.artist,
  metadata: { genres: [...new Set(entry.albums.flatMap((album) => album.genres))] },
  albumIds: albums.filter((album) => album.artistId === entry.artistId).map((album) => album.id),
  sources: ["aurral"],
  available: true,
}));

const tracks = albums.flatMap((album, index) => {
  const artist = artists.find((entry) => entry.id === album.artistId);
  const albumTracks = tracksForAlbum({
    ...album,
    artist: artist.name,
    genres: album.metadata.genres,
  }, index);
  album.trackIds = albumTracks.map((track) => track.id);
  return albumTracks;
});

export const libraryPreviewData = { artists, albums, tracks };

export const libraryPreviewFavorites = new Set([
  "artist:preview-artist%3Apreview-artist-night-archive",
  "album:preview-album%3A1-1",
  "song:preview-track%3A1-1",
]);
