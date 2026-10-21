const aliases = {
  trackName: ["Track Name", "Track", "Track Title", "Title", "Song", "Song Name", "Name"],
  artistName: [
    "Artist Name(s)",
    "Artist Name",
    "Artist",
    "Artists",
    "Artist(s)",
    "Artist Names",
    "Track Artist",
  ],
  albumName: ["Album Name", "Album", "Release", "Release Name", "Record", "Collection"],
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  if (quoted) throw new Error("The CSV contains an unclosed quoted field.");
  return rows;
}

function normalize(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function columnIndex(headers, names) {
  const normalized = headers.map(normalize);
  return (
    names
      .map(normalize)
      .map((name) => normalized.indexOf(name))
      .find((index) => index >= 0) ?? -1
  );
}

export function convertSpotifyCsv(csv, filename = "playlist.csv") {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("The CSV is empty or has no track rows.");

  const trackIndex = columnIndex(rows[0], aliases.trackName);
  const artistIndex = columnIndex(rows[0], aliases.artistName);
  const albumIndex = columnIndex(rows[0], aliases.albumName);

  if (trackIndex < 0 || artistIndex < 0) {
    throw new Error("The CSV needs both a track/title column and an artist column.");
  }

  const tracks = rows.slice(1).flatMap((columns) => {
    const artistName = columns[artistIndex]?.trim();
    const trackName = columns[trackIndex]?.trim();
    if (!artistName || !trackName) return [];
    return [{ artistName, albumName: columns[albumIndex]?.trim() ?? "", trackName }];
  });

  if (!tracks.length) throw new Error("No complete artist and track rows were found.");

  const name =
    filename
      .replace(/\.csv$/i, "")
      .replace(/[_-]+/g, " ")
      .trim() || "My Playlist";
  return { name, tracks };
}
