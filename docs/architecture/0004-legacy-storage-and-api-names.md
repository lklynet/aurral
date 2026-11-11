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

The JSON API uses the current names too. Version 2 of the [app contract](../src/content/docs/api/app-contract.mdx#changes-from-version-1) dropped the older names that version 1 returned beside them. `library*Id` always means a Library ID. `provider*Id` was the ID in Lidarr while Lidarr could manage an item. It is always null now and stays for apps that read it.

`LIBRARY_FOLDER` names the Library folder. `DOWNLOAD_FOLDER`, `WEEKLY_FLOW_FOLDER`, and `PLAYLIST_FOLDER` still work and log a warning.

Playlist files live in `_playlists` in the Library folder. At boot, before the server listens, Aurral moves them there from `aurral-weekly-flow/_playlists`. It must finish first: a playlist written at the new path while uploaded artwork still sits at the old one would replace that artwork. Media servers see the move as new files. Jellyfin replaces each playlist, and Navidrome keeps the old copy beside the new one until someone deletes it.

These names stay, because something outside Aurral depends on them or renaming them would cost more than it explains:

| Name                         | Where                       | Holds                                                   |
| ---------------------------- | --------------------------- | ------------------------------------------------------- |
| `playlistId`, `playlistType` | Job fields                  | The owner, `library` or a flow ID, or `quality-upgrade` |
| `canonicalJobId`             | Static playlist track field | The Library job that the track references               |
| `canonicalAlbumId`           | Stored activity metadata    | The Library album, read into `libraryAlbumId`           |
| `shared`, `shared-song`      | Subsonic IDs                | Static playlists and their songs                        |
| `downloadFolderPath`         | Settings key                | The Library folder                                      |

Subsonic clients store `shared` and `shared-song` IDs for favorites, offline caches, and playlists, so a rename would make them treat existing items as new ones.

Migration code keeps the old names, such as `weeklyFlows` and `playlist_download_jobs`, because it describes data from older versions.

## Upgrading from Aurral 2

Aurral 3 opens a database only when Aurral 2 finished every upgrade step on it (`backend/config/upgrade-gate.ts`). Otherwise it exits before it writes anything and asks the admin to start the `2` image first. That is why 3.0 carries no code for data from before 2.x: no old path remapping, no 2.x settings readers, and no 2.x table rebuilds. Don't add any back.

A schema or data change is a new function at the end of `migrations` in `backend/config/migrations.ts`. Aurral runs the ones a database hasn't run yet, in order, in one transaction, and counts them in `PRAGMA user_version`. Never edit, reorder, or remove a migration that shipped, and don't add a marker: the count is the marker. Migration 1 is the 3.0 schema and every 3.0 data upgrade. It tolerates columns and rows that already exist, because databases from 2.x and 3.0 nightlies start at 0.

Once 3.x has settled, 3.0's own upgrade code retires. Gate on `user_version` 1, not `schemaVersion` 5, because Aurral stamps 5 before migrations run. Three steps run outside the list and still need their markers: the job queue move and the Lidarr conversion, which snapshot the database first, and the playlist file move, which touches the Library folder. Gate on `migration:job-queue-v1`, `migration:lidarr-conversion-v1`, and `migration:playlist-files-v1` too. The conversion reads columns that a later step in the list drops, so it has to run before the list. The playback server cleanup carries no marker because it is done once its old settings are gone. The `DOWNLOAD_FOLDER`, `WEEKLY_FLOW_FOLDER`, and `PLAYLIST_FOLDER` fallbacks go in the same release. So do the variables from before Settings held integrations: `LASTFM_API_KEY`, `LASTFM_API_SECRET`, and `CONTACT_EMAIL`. `LIDARR_API_KEY` goes with the conversion, which reads it to tell that Lidarr was connected. Until then `backend/services/deprecatedUsage.ts` logs a warning for each one that is set.
