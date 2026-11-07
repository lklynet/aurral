# Legacy storage and API names

Status: Accepted

## Problem

Aurral started with one weekly flow that owned its tracks. Today the Library owns every track. A static playlist is a fixed or synced list of references to Library tracks, and a flow is a playlist that Aurral rebuilds on a schedule from temporary files. Flows and static playlists are the two kinds of playlist.

The code kept the old names long after the model changed. `weeklyFlow` modules ran every download, `sharedPlaylist` meant static playlist, and "canonical library" meant the only library there is. New contributors went looking for systems that no longer exist.

## Decision

Code uses names that match the current model:

- `backend/services/downloadJobs` runs download jobs for the Library, flows, and upgrades.
- `backend/services/flows` builds and schedules flows.
- `backend/services/playlists` stores flows and static playlists and runs playlist operations.
- `backend/routes/playlists` serves `/api/playlists`.
- `frontend/src/pages/playlists` holds the flow and static playlist pages.

Stored data uses the current names too. When Aurral moved to its own job queue, one startup migration renamed the tables, columns, queues, task kinds, and settings keys (`backend/config/job-queue-migration.ts`). An older build cannot read the renamed data, so the migration first writes a snapshot, `aurral.pre-job-queue.db`, to the data dir.

The JSON API uses the current names too. Version 1 of the [app contract](../src/content/docs/api/app-contract.mdx#renamed-in-version-1) still accepts and returns the older ones beside them, so Aurral apps keep working until they move over, and `currentNames` tells an app the new names exist. Version 2 removes them. Two choices there are easy to undo by accident:

- The websocket playlist status carries only `staticPlaylists`. Only the web app reads it, and the list includes every track, so sending both names doubles each update. `GET /api/playlists/status` adds the older names for apps.
- Album lookup objects already used `libraryAlbumId` and `libraryArtistId` for the managing service's IDs. They keep that meaning in version 1, next to `providerAlbumId` and `providerArtistId`. Version 2 makes them Library IDs, so `library*Id` always means a Library ID.

`LIBRARY_FOLDER` names the Library folder. `DOWNLOAD_FOLDER`, `WEEKLY_FLOW_FOLDER`, and `PLAYLIST_FOLDER` still work and log a warning.

These names stay, because something outside Aurral depends on them or renaming them would cost more than it explains:

| Name                         | Where                       | Holds                                                   |
| ---------------------------- | --------------------------- | ------------------------------------------------------- |
| `playlistId`, `playlistType` | Job fields                  | The owner, `library` or a flow ID, or `quality-upgrade` |
| `canonicalJobId`             | Static playlist track field | The Library job that the track references               |
| `canonicalAlbumId`           | Stored activity metadata    | The Library album, read into `libraryAlbumId`           |
| `shared`, `shared-song`      | Subsonic IDs                | Static playlists and their songs                        |
| `aurral-weekly-flow/`        | Library folder              | Playlist artwork and sidecar files                      |
| `downloadFolderPath`         | Settings key                | The Library folder                                      |

Subsonic clients store `shared` and `shared-song` IDs for favorites, offline caches, and playlists, so a rename would make them treat existing items as new ones.

Migration code keeps the old names, such as `weeklyFlows` and `playlist_download_jobs`, because it describes data from older versions.
