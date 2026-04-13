# Flows and Playlists

Flows are dynamic weekly recommendations, while playlists are static tracklists imported from JSON.

- **Flows** are recommended playlists that refresh weekly
- **Playlists** are static tracklists created from exported JSON or hand-written JSON
- Imported *playlists* stay separate from weekly *flow* refreshes
- Imported *playlists* use the same Soulseek download worker, but they retry the exact imported tracks rather than generating replacements

## What the importer accepts

The importer accepts four JSON shapes:

1. An exported Aurral playlist file
2. A single playlist object with a `tracks` array
3. A raw array of tracks
4. A bundle object with a `playlists` array

## Required track fields

Each track must include:

- `artistName`
- `trackName`

Accepted aliases:

- artist: `artistName`, `artist`, `artist_name`, `Artist Name(s)`
- track: `trackName`, `title`, `name`, `track`, `Track Name`
- album: `albumName`, `album`, `Album Name`
- artist id: `artistMbid`, `artistId`, `mbid`

## Spotify playlist import (Exportify + CSVJSON)

You can import Spotify playlists today with a CSV-to-JSON bridge:

1. Export your Spotify playlist from [Exportify](https://exportify.net/)
2. Convert that CSV to JSON using [CSVJSON](https://csvjson.com/csv2json)
3. Import that JSON file in Aurral from the playlist import modal

CSVJSON output is a raw array of track objects, which Aurral accepts directly as one playlist. Aurral reads Spotify-style keys like `Track Name`, `Artist Name(s)`, and `Album Name` during import.

## Accepted JSON examples

### 1. Exported Aurral playlist file

```json
{
  "type": "aurral-static-tracklist",
  "version": 1,
  "exportedAt": "2026-03-25T12:00:00.000Z",
  "name": "Late Night Finds",
  "sourceName": "Friday Flow",
  "sourceFlowId": "abc123",
  "trackCount": 2,
  "tracks": [
    {
      "artistName": "Burial",
      "trackName": "Archangel",
      "albumName": "Untrue",
      "artistMbid": null
    },
    {
      "artistName": "Four Tet",
      "trackName": "Two Thousand and Seventeen",
      "albumName": null,
      "artistMbid": null
    }
  ]
}
```

### 2. Single playlist object

```json
{
  "name": "My Playlist",
  "tracks": [
    { "artistName": "Massive Attack", "trackName": "Teardrop" },
    { "artistName": "Portishead", "trackName": "Roads" }
  ]
}
```

### 3. Raw array of tracks

```json
[
  { "artistName": "Burial", "trackName": "Archangel" },
  { "artistName": "Air", "trackName": "La Femme d'Argent" }
]
```

### 4. Multi-playlist bundle

```json
{
  "playlists": [
    {
      "name": "Warm",
      "tracks": [
        { "artistName": "Bonobo", "trackName": "Kiara" }
      ]
    },
    {
      "name": "Dark",
      "tracks": [
        { "artistName": "Burial", "trackName": "Near Dark" }
      ]
    }
  ]
}
```

### 5. Nested playlist wrapper

```json
{
  "playlist": {
    "name": "Imported Set",
    "tracks": [
      { "artistName": "Air", "trackName": "La Femme d'Argent" }
    ]
  }
}
```

## Notes

- A top-level array of track objects is treated as one playlist
- A top-level array of playlist objects is treated as multiple playlists
- If a playlist name conflicts with an existing imported playlist, Aurral renames it automatically
- Imported playlists queue their own downloads and do not change any flow configuration
- Flows can generate replacement tracks when they come up short
- Imported playlists retry the same tracks from the JSON and do not generate replacements

## Download retries and failure behavior

- Each imported track is queued as its own worker job
- Retryable failures get an immediate retry with backoff (base 5s, capped at 120s)
- Known non-retryable errors are effectively blacklisted from immediate retries (`User not exist`, `User offline`, `No search results found`, `No candidate files returned`)
- If a playlist is incomplete and has no pending/downloading jobs, failed tracks are requeued in the periodic incomplete-playlist cycle (about every 15 minutes)
- Imported playlists keep retrying the same original tracklist; only flows may generate replacement tracks
