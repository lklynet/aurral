# Static playlist download jobs

Status: Accepted

## Problem

Static playlists use two job models. Imports and adds from the browser app create download jobs owned by the playlist. Subsonic playlist edits create Library jobs that the playlist references, and treat playlist-owned jobs as legacy. Code that reads, removes, or upgrades a static playlist track handles both, and deleting a playlist moves job ownership to another playlist that still uses the track.

The Library owns tracks. A static playlist is a list of references to them.

## Decision

### Owners

A download job belongs to the Library or to one flow. An upgrade job belongs to the owner of the job it upgrades, and `upgrade_for_job_id` marks it. Nothing else used `playlist_type`, so 3.0 drops it.

### References

A static playlist track references a Library job by `jobId`. Adding a track reuses the Library job for the same track when one exists, finished or not. Otherwise Aurral creates one. This applies to imports, syncs, adds from the browser app, Subsonic edits, and copies between playlists.

### Who asked for a job

A Library job records whether a static playlist queued it, in `queued_for_playlist`. Aurral sets it only when it downloads the track for the playlist. A job that points at a file already in the Library never has it.

A direct request clears it on the existing job. Direct requests are adding a track to the Library, an album request, monitoring, and **Re-search**.

### Removing tracks

Removing a track, deleting a playlist, a sync that drops a track, and a Subsonic edit all remove the membership first. Aurral then releases each job that lost a reference when:

- a static playlist queued it,
- no static playlist still references it, and
- it is not an upgrade job.

Releasing an unfinished job cancels its download and its upgrades, then deletes the job.

Releasing a finished job deletes the job and its file, following the file safety rules in [0003](0003-playlist-download-removal-safety.md). The exception is a sync drop while **Keep removed tracks in library** is on. That clears `queued_for_playlist` instead, so the track stays in the Library like any other.

Other jobs stay in the Library. Deleting a playlist never moves a job to another playlist.

## Migration

The schema 5 migration moves each job owned by a static playlist into the Library:

- The owner becomes `library` at the Library's current generation. Pipeline payloads and provider work move with it, so downloads in progress continue.
- `queued_for_playlist` is set when the job is unfinished or a download client fetched it.
- The playlist track with the same membership references the job. If no track matches, Aurral adds one built from the job, because the playlist already shows it.
- An unfinished job whose playlist no longer exists is cancelled and deleted. A finished one stays in the Library.

Cancellation rows for static playlists are deleted. Flow rows stay.

## Consequences

- A job has one owner for its whole life, so ownership transfers and their payload rewrites are gone.
- A track queued by a playlist and later requested directly stays when the playlist goes.
- Jobs that Subsonic edits created before 3.0 do not record that a playlist queued them, so removing them keeps their files, as in 2.x.
