# Playlist download removal safety

Status: Accepted

## Problem

A playlist import creates Aurral jobs, Honker pipeline jobs, and provider work. Removing the playlist used to clear the Aurral tracker without cancelling the other work. A running pipeline could then finish and move a file into the removed playlist, or leave a file that no tracker row described.

The operation is asynchronous. The delete endpoint can return before the worker has removed the playback playlist and its files.

## Decision

Treat playlist removal as a durable cancellation boundary.

- SQLite stores a cancellation state and a generation for each playlist.
- SQLite stores cancellation tombstones for individual jobs.
- For providers whose work can outlive a pipeline payload, SQLite records the operation ID as soon as work is created; the durable provider-work path currently covers slskd searches.
- Playlist-scoped cleanup includes quality-upgrade jobs whose owning playlist ID is stored separately from their queue type.
- Each download job stores the playlist generation that was active when Aurral created it.
- The worker, pipeline payload, and commit handler use the stored generation.
  They never substitute the playlist's current generation.
- The delete path marks the playlist cancelled before it waits for the playlist mutation lock.
- The delete path cancels matching Honker jobs and known provider work before it clears tracker rows.
- A pipeline checks the durable state before each phase and before it queues another phase.
- A finalizer and playlist deletion share the `playlist-mutation:<playlistId>` lock. A finalizer that gets the lock first completes before deletion removes the file. A finalizer that waits sees the cancellation state and does not import the file.
- Before clearing shared-playlist jobs, deletion removes Aurral-managed completed files that no other job or playback playlist uses. Files owned elsewhere stay in place.
- Clearing all jobs snapshots the current rows, cancels those jobs, and removes them under the affected playlist locks. Jobs created after the snapshot stay queued.
- Library-track removal waits for provider cleanup before deleting matching jobs or files. If cleanup fails, the library track and job stay in place for a later retry.

When a playlist is created again with the same ID, Aurral advances the generation. Payloads from the removed playlist remain invalid even if their Honker rows survive a restart.

## Provider limits

Aurral cancels provider work when the adapter exposes a verified operation:

- slskd searches recorded durably or found in the pipeline payload are deleted; transfer IDs found in the pipeline payload are also deleted.
- deemix queue items are removed.
- SABnzbd queue and history deletion checks the response status. If SABnzbd reports that it removed nothing, Aurral confirms that the item is absent before treating cleanup as complete.
- yt-dlp waits for an active process to exit, killing it if necessary, before removing its staging directory.

If slskd, deemix, or SABnzbd has tracked work but is no longer configured, cancellation fails and retains the playlist and jobs for a later retry. A disabled integration cannot confirm that its remote work stopped.

Aurral does not delete a source file merely because a Usenet or deemix provider reports its path. A path mapping can point into a shared library. The provider response does not prove that Aurral owns the file. Cancellation prevents import, while provider-specific cleanup handles work that Aurral can identify.

Subsonic playlist edits use the same mutation lock as other playlist operations. They cancel only legacy jobs removed by the replacement and preserve jobs and files for tracks that remain. If provider cancellation fails, the old playlist stays in place. Its pending jobs resume, while interrupted downloads become failed jobs that the user can retry. If flow or playlist cleanup cannot be queued, Aurral restores only the cancellation markers created by that request; a failed flow disable also restores its previous enabled state. Track removal similarly clears only its newly created job marker when queueing fails.

The NZBGet adapter does not expose a verified queue-cancel operation. Aurral therefore stops the Aurral pipeline and refuses to import a result after removal, but it does not claim that NZBGet stopped the remote download.

yt-dlp staging cleanup does not require yt-dlp to be configured because it removes local files.

## User-visible behavior

Playlist and flow deletion are queued operations. The UI reports that removal is queued until the background operation completes. Activity can still show work while a provider finishes a request, but that work cannot create a new Aurral playlist file after the cancellation boundary.

Clearing all jobs waits for in-flight playlist imports. Jobs created after the clear starts stay queued. If provider cleanup fails, Aurral keeps the affected jobs in a failed state with a cancellation-pending reason and reports the error. Durable cancellation prevents those jobs from running or importing results. After restoring the provider connection, retry clearing all jobs to try remote cleanup again. Removing a library track stops if provider cleanup fails, leaving the track and its job available for retry.
