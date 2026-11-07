# Legacy storage and API names

Status: Accepted

## Problem

Aurral started with one weekly flow that owned its tracks. Today the Library owns every track. A static playlist is a fixed or synced list of references to Library tracks, and a flow is a playlist that Aurral rebuilds on a schedule from temporary files. Flows and static playlists are the two kinds of playlist.

The code kept the old names long after the model changed. `weeklyFlow` modules ran every download, `sharedPlaylist` meant static playlist, and "canonical library" meant the only library there is. New contributors went looking for systems that no longer exist.

## Decision

Code uses names that match the current model:

- `backend/services/downloadJobs` runs download jobs for the Library, static playlists, flows, and upgrades.
- `backend/services/flows` builds and schedules flows.
- `backend/services/playlists` stores flows and static playlists and runs playlist operations.
- `backend/routes/playlists` serves `/api/playlists`.
- `frontend/src/pages/playlists` holds the flow and static playlist pages.

Stored data uses the current names too. When Aurral moved to its own job queue, one startup migration renamed the tables, columns, queues, task kinds, and settings keys (`backend/config/job-queue-migration.ts`). An older build cannot read the renamed data, so the migration first writes a snapshot, `aurral.pre-job-queue.db`, to the data dir.

Public APIs, the Library folder, and the fields apps read keep their old names, because Aurral apps, Subsonic clients, and media servers depend on them. The table below lists each old name and what it holds now. Rename one only with a plan for existing clients.

| Name                                                                                           | Where                                 | Holds                                                                         |
| ---------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| `playlistId`                                                                                   | Job field                             | The owner, which is `library`, a flow ID, or a static playlist ID             |
| `playlistType`                                                                                 | Job field                             | The owner again, or `quality-upgrade` for an upgrade job                      |
| `sharedPlaylists`                                                                              | `/api/playlists/status` field         | Static playlists                                                              |
| `sharedPlaylistStats`                                                                          | `/api/playlists/status` field         | Download counts for each static playlist                                      |
| `canonicalJobId`                                                                               | Static playlist track field           | The Library job that the track references                                     |
| `canonicalId`, `canonicalArtistId`, `canonicalAlbumId`, `canonicalTrackId`, `albumCanonicalId` | Library API fields                    | Library record IDs                                                            |
| `canonical`, `canonicalInLibrary`                                                              | Library lookup responses              | Whether the answer came from the Library index rather than a live Lidarr read |
| `/api/library/canonical`, `readPath=canonical`, `/api/library/canonical-stream`                | Library API                           | Library pages, reads, and streams                                             |
| `/api/playlists/shared-playlists`                                                              | Playlist API                          | Static playlist routes                                                        |
| `shared`, `shared-song`                                                                        | Subsonic IDs                          | Static playlists and their songs                                              |
| `accessFlow`                                                                                   | User permission                       | Access to flows and static playlists                                          |
| `aurral-weekly-flow/`                                                                          | Library folder                        | Playlist artwork and sidecar files                                            |
| `downloadFolderPath`, `DOWNLOAD_FOLDER`                                                        | Settings key and environment variable | The Library folder, where Aurral keeps the music it adds                      |
| `WEEKLY_FLOW_FOLDER`, `PLAYLIST_FOLDER`                                                        | Environment variables                 | Older names for `DOWNLOAD_FOLDER`, read before it                             |

Migration code keeps the old names, such as `weeklyFlows` and `playlist_download_jobs`, because it describes data from older versions.
