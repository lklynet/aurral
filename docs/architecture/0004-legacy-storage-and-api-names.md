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

Stored data, queued work, and public APIs keep their old names. Renaming them needs a migration, and an older build would then lose sight of the data after a downgrade. The table below lists each old name and what it holds now. Rename one only together with a migration and a plan for existing clients.

| Name | Where | Holds |
| --- | --- | --- |
| `playlist_download_jobs` | SQLite table | Every download job |
| `playlist_id`, `playlistId` | Job column and field | The owner, which is `library`, a flow ID, or a static playlist ID |
| `playlist_type`, `playlistType` | Job column and field | The owner again, or `quality-upgrade` for an upgrade job |
| `weekly_flow_download_cancellations`, `weekly_flow_download_job_cancellations`, `weekly_flow_download_provider_work` | SQLite tables | Download cancellation state |
| `sharedPlaylists` | Settings key and `/api/playlists/status` field | Static playlists |
| `sharedPlaylistStats` | `/api/playlists/status` field | Download counts for each static playlist |
| `canonicalJobId` | Static playlist track field | The Library job that the track references |
| `canonicalId`, `canonicalArtistId`, `canonicalAlbumId`, `canonicalTrackId`, `albumCanonicalId` | Library API fields | Library record IDs |
| `canonical`, `canonicalInLibrary` | Library lookup responses | Whether the answer came from the Library index rather than a live Lidarr read |
| `/api/library/canonical`, `readPath=canonical`, `/api/library/canonical-stream` | Library API | Library pages, reads, and streams |
| `/api/playlists/shared-playlists` | Playlist API | Static playlist routes |
| `/api/weekly-flow`, `weekly-flow` channel | API redirect and WebSocket | Older names for `/api/playlists` and the `playlists` channel |
| `shared`, `shared-song` | Subsonic IDs | Static playlists and their songs |
| `weekly-flow-operation` | Honker queue | Playlist and flow operations |
| `weekly-flow-refresh`, `weekly-flow-reuse-repair`, `weekly-flow-startup-check`, `weekly-flow-startup-reuse-repair` | Honker system tasks | Flow scheduling and file reuse repair |
| `shared-playlist-*` | Queued operation kinds | Static playlist operations |
| `weeklyFlowIncompleteRetryJobs`, `weeklyFlowOperationTokens` | Settings keys | Retry and operation token registries |
| `accessFlow` | User permission | Access to flows and static playlists |
| `notifyWeeklyFlowDone` | Notification setting and webhook event | The flow finished notification |
| `aurral-weekly-flow/` | Downloads Folder | Playlist artwork and sidecar files |
| `WEEKLY_FLOW_FOLDER`, `PLAYLIST_FOLDER` | Environment variables | Older names for `DOWNLOAD_FOLDER`, read before it |

Migration code that reads older settings, such as `weeklyFlows` and `weeklyFlowWorker`, keeps those names because it describes data from older versions.
