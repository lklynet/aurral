# Playlist download removal safety

Status: Accepted

## Problem

A playlist import creates Aurral jobs, Honker pipeline jobs, and provider work. Removing the playlist used to clear the Aurral tracker without cancelling the other work. A running pipeline could then finish and move a file into the removed playlist, or leave a file that no tracker row described.

The operation is asynchronous. The delete endpoint can return before the worker has removed the playback playlist and its files.

## Decision

Treat playlist removal as a durable cancellation boundary.

- SQLite stores a cancellation state and a generation for each download owner, the Library or a flow.
- SQLite stores cancellation tombstones for individual jobs.
- For providers whose work can outlive a pipeline payload, SQLite records the operation ID as soon as work is created; the durable provider-work path currently covers slskd searches.
- Owner-scoped cleanup includes quality-upgrade jobs, which belong to the owner of the job they upgrade.
- Each download job stores the owner generation that was active when Aurral created it.
- The worker, pipeline payload, and commit handler use the stored generation.
  They never substitute the owner's current generation.
- Deleting a flow marks it cancelled before it waits for the download locks. Removing static playlist tracks cancels only the jobs it releases, as [0006](0006-static-playlist-download-jobs.md) describes.
- The delete path cancels matching Honker jobs and known provider work before it clears tracker rows.
- A pipeline checks the durable state before each phase and before it queues another phase.
- Download locks are keyed by the job's owner, stored as `owner_id`. Library downloads, including the ones static playlists queue, share the owner `library`; each flow uses its own ID. A pipeline phase holds `download-step:<owner>` for the whole phase. Importing a file holds `download-import:<owner>`. Deletion and other ownership changes take both locks, the step lock first.
- Because every library job shares one step lock, a pipeline step makes one provider call. A search starts or polls once per step instead of waiting for the provider inside the lock.
- A finalizer and playlist deletion share the import lock. A finalizer that gets the lock first completes before deletion removes the file. A finalizer that waits sees the cancellation state and does not import the file.
- Approving a download held for review takes only the import lock. It waits for other imports and ownership changes, but not for another track's search or transfer. It then publishes the playlist under the step lock, so a deletion or edit cannot run while that publish is in progress.
- A flow refresh validates its operation token, flow state, and planned settings under both download locks before it cancels old jobs. Flow settings updates take the same locks. A stale plan therefore leaves the current jobs active, and a settings update cannot race provider cleanup.
- Releasing a finished static playlist job removes its Aurral-managed file unless another job or playback playlist uses it. Files owned elsewhere stay in place.
- Clearing all jobs snapshots the current rows, cancels those jobs, and removes them under the affected playlist locks. Jobs created after the snapshot stay queued.
- Library-track removal waits for provider cleanup before deleting matching jobs or files. If cleanup fails, the library track and job stay in place for a later retry.
- Library-track deletion reads each matching job's current `finalPath` after provider cancellation finishes. It includes that path in file cleanup before removing the track, so a finalizer that already held the lock cannot leave an untracked file behind.
- Library-track deletion checks playlist file references before unlinking a path. It moves a shared managed file to a surviving playlist. It leaves other referenced files in place when it cannot move them safely.
- Library-track and album deletion remove the static playlist tracks that referenced the deleted library jobs, under each playlist's download locks. Quick and full library refreshes remove any remaining static playlist track whose referenced job no longer exists, so a failed or older deletion cannot leave a hidden track that still blocks adding the same song.
- slskd, deemix, and Usenet submissions use the import lock. Each handler records the provider ID before releasing the lock, and cancellation reads the current job metadata after it acquires the lock. A failed provider cleanup therefore leaves the ID available for retry.
- A failed static playlist edit or deletion leaves the playlist unchanged and restores the job cancellations it made. Downloads it interrupted become failed jobs that the user can retry.

When a flow is created again with the same ID, Aurral advances the generation. Payloads from the removed flow remain invalid even if their Honker rows survive a restart.

## Provider limits

Aurral cancels provider work when the adapter exposes a verified operation:

- slskd searches recorded durably or found in the pipeline payload are deleted; transfer IDs found in the pipeline payload are also deleted.
- deemix queue items are removed.
- SABnzbd and NZBGet queue and history deletion checks the response status. If the client reports that it removed nothing, Aurral confirms that the item is absent before treating cleanup as complete.
- yt-dlp waits for an active process to exit, killing it if necessary, before removing its staging directory.

If slskd, deemix, SABnzbd, or NZBGet has tracked work but is no longer configured, cancellation fails and retains the playlist and jobs for a later retry. A disabled integration cannot confirm that its remote work stopped.

Aurral does not delete a source file merely because a Usenet or deemix provider reports its path. A path mapping can point into a shared library. The provider response does not prove that Aurral owns the file. Cancellation prevents import, while provider-specific cleanup handles work that Aurral can identify.

Subsonic playlist edits release jobs like other static playlist edits, under the same download locks. If provider cancellation fails, the old playlist stays in place. If flow or playlist cleanup cannot be queued, Aurral restores only the cancellation markers created by that request; a failed flow disable also restores its previous enabled state. Track removal similarly clears only its newly created job marker when queueing fails.

yt-dlp staging cleanup does not require yt-dlp to be configured because it removes local files.

## User-visible behavior

Playlist and flow deletion are queued operations. The UI reports that removal is queued until the background operation completes. Activity can still show work while a provider finishes a request, but that work cannot create a new Aurral playlist file after the cancellation boundary.

Clearing all jobs waits for in-flight playlist imports. Jobs created after the clear starts stay queued. If provider cleanup fails, Aurral keeps the affected jobs in a failed state with a cancellation-pending reason and reports the error. Durable cancellation prevents those jobs from running or importing results. After restoring the provider connection, retry clearing all jobs to try remote cleanup again. Removing a library track stops if provider cleanup fails, leaving the track and its job available for retry.
