# The app log

Status: Accepted

## Problem

Aurral only printed to the console. Most lines were hidden by default, nothing was kept, and worker processes printed to the parent's output. Users had nothing to share when something broke, and nobody could look back at a failure that happened overnight.

## Decision

Aurral keeps one log in `<data dir>/logs/aurral.log`, as JSON Lines, and serves it at `/api/logs` to admins and the API key.

- **One writer.** Only the main process writes the file. Workers send each entry over their IPC channel as a `log` message. Two processes rotating one file would lose lines, and appends from several processes interleave on network shares.
- **Bounded size.** The writer starts a new file at 10 MB and keeps five: `aurral.log`, then `aurral.1.log` to `aurral.4.log`. Batched, synchronous appends keep lines in order and flush on exit.
- **Everything is saved, the console stays quiet.** Info and above always reach the file. Debug lines reach it only while debug logging is on. Console output follows `AURRAL_VERBOSE_LOGS` as before. In the server and worker processes, raw `console.*` calls are saved too, with the category taken from a leading `[Tag]`.
- **Secrets are masked when written.** Entries go through the same masking as the console, and stacks keep only their frames. The file is safe to share, so the export does no extra filtering.
- **Repeats share a fingerprint.** `fp` hashes the level, category, message, and reason with quoted text, ids, and numbers stripped. Problems group by it. Failed outgoing requests hash only their exact message, so each host and status is its own problem however the network error changes from one try to the next.

## Traps

- The reader matches `{"id":…,"ts":"…","level":"…"` at the start of each line to skip parsing lines it doesn't need. The writer must keep those three keys first.
- `id` is the cursor for paging, not `ts`. Worker entries carry the time they were made, so `ts` is only roughly in file order.
- Failed outgoing requests are logged from `lib/axiosFetch.ts` without the query string, since many integrations put keys there.
