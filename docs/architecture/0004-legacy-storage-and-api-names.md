# Storage and API names

Status: Accepted

## Problem

Aurral started with one weekly flow that owned its tracks. Today the Library owns every track. A static playlist is a fixed or synced list of references to Library tracks, and a flow is a playlist that Aurral rebuilds on a schedule from temporary files. Flows and static playlists are the two kinds of playlist.

Aurral 2 kept the old names long after the model changed. `weeklyFlow` modules ran every download, `sharedPlaylist` meant static playlist, and "canonical library" meant the only library there is. New contributors went looking for systems that no longer exist.

## Decision

Code, stored data, queued work, and public APIs use names that match the current model. Aurral 2 renamed the code. The schema 5 migration in Aurral 3.0 renamed what Aurral stores and serves, as [0005](0005-aurral-3-upgrade.md) describes.

| Aurral 2 name | Aurral 3 name | Holds |
| --- | --- | --- |
| `playlist_download_jobs` | `download_jobs` | Every download job |
| `playlist_id`, `playlistId` on a job | `owner_id`, `ownerId` | The Library or the flow that owns the job |
| `playlist_generation`, `playlistGeneration` | `owner_generation`, `ownerGeneration` | The owner's download generation |
| `playlist_type`, `playlistType` | removed | `upgrade_for_job_id` marks an upgrade job |
| `weekly_flow_download_cancellations` | `download_owner_cancellations` | Download generation of each owner |
| `weekly_flow_download_job_cancellations` | `download_job_cancellations` | Cancelled jobs |
| `weekly_flow_download_provider_work` | `download_provider_work` | Provider work to cancel |
| `sharedPlaylists` settings key and status field | `staticPlaylists` | Static playlists |
| `sharedPlaylistStats`, `sharedStats` status fields | `staticPlaylistStats`, `staticPlaylistTotals` | Download counts of static playlists |
| `canonicalJobId` on a static playlist track | `jobId` | The Library job that the track references |
| `/api/playlists/shared-playlists` | `/api/playlists/static-playlists` | Static playlist routes |
| `shared-playlist-*` operation kinds | `static-playlist-*` | Static playlist operations |
| `reset-playlists` operation with `playlistTypes` | `reset-flows` with `flowIds` | Flow resets |
| `weekly-flow-operation` queue | `playlist-operation` | Playlist and flow operations |
| `weekly-flow-refresh`, `weekly-flow-startup-check` tasks | `flow-refresh`, `flow-startup-check` | Flow scheduling |
| `weekly-flow-reuse-repair`, `weekly-flow-startup-reuse-repair` tasks | `file-reuse-repair`, `startup-file-reuse-repair` | File reuse repair |
| `weeklyFlowIncompleteRetryJobs`, `weeklyFlowOperationTokens` settings | `incompleteRetryJobs`, `playlistOperationTokens` | Retry and operation token registries |
| `accessFlow` permission | `accessPlaylists` | Access to flows and static playlists |
| `notifyWeeklyFlowDone` setting and webhook event | `notifyFlowDone` | The flow finished notification |
| `canonicalId`, `canonicalArtistId`, `canonicalAlbumId`, `canonicalTrackId`, `albumCanonicalId` | `recordId`, `artistRecordId`, `albumRecordId`, `trackRecordId` | Library record IDs |
| `/api/library/canonical`, `readPath=canonical` | `/api/library/records`, `readPath=records` | Library pages and reads |
| `/api/library/canonical-stream` | `/api/library/records/stream` | Library streams |
| `aurral-weekly-flow/_playlists` | `_playlists` | Playlist artwork and sidecar files |

Aurral 3.0 removed the `/api/weekly-flow` redirect, the `weekly-flow` WebSocket channel, the `canonical` lookup flags, and the `WEEKLY_FLOW_FOLDER` and `PLAYLIST_FOLDER` variables.

## Names that keep their old spelling

- **Subsonic playlist IDs `shared` and `shared-song`.** Clients such as Feishin store them with pinned playlists and stars. Renaming them would throw away client state for IDs that nobody sees.
- **The `flow` media source.** It is accurate.

Rename one of these only together with a migration and a plan for existing clients.
