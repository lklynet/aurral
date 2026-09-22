# Playlist download removal safety

Status: Accepted

## Problem

A playlist import creates Aurral jobs, Honker pipeline jobs, and provider work. Removing the playlist used to clear the Aurral tracker without cancelling the other work. A running pipeline could then finish and move a file into the removed playlist, or leave a file that no tracker row described.

The operation is asynchronous. The delete endpoint can return before the worker has removed the playback playlist and its files.

## Decision

Treat playlist removal as a durable cancellation boundary.

- SQLite stores a cancellation state and a generation for each playlist.
- SQLite stores cancellation tombstones for individual jobs.
- Playlist-scoped cleanup includes quality-upgrade jobs whose owning playlist ID is stored separately from their queue type.
- Each new download payload carries the playlist generation.
- The delete path marks the playlist cancelled before it waits for the playlist mutation lock.
- The delete path cancels matching Honker jobs and known provider work before it clears tracker rows.
- A pipeline checks the durable state before each phase and before it queues another phase.
- A finalizer and playlist deletion share the `playlist-mutation:<playlistId>` lock. A finalizer that gets the lock first completes before deletion removes the file. A finalizer that waits sees the cancellation state and does not import the file.

When a playlist is created again with the same ID, Aurral advances the generation. Payloads from the removed playlist remain invalid even if their Honker rows survive a restart.

## Provider limits

Aurral cancels provider work when the adapter exposes a verified operation:

- slskd searches and transfer IDs found in the pipeline payload are deleted.
- deemix queue items are removed.
- SABnzbd history items are removed when a job has a known ID.
- yt-dlp staging is removed, and an active yt-dlp process checks the durable job cancellation state.

The NZBGet adapter does not expose a verified queue-cancel operation. Aurral therefore stops the Aurral pipeline and refuses to import a result after removal, but it does not claim that NZBGet stopped the remote download.

## User-visible behavior

Playlist and flow deletion are queued operations. The UI reports that removal is queued until the background operation completes. Activity can still show work while a provider finishes a request, but that work cannot create a new Aurral playlist file after the cancellation boundary.
