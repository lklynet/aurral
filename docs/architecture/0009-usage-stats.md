# Usage stats

Status: Accepted

## Problem

We decide what to build, keep, and remove without knowing how Aurral is used. Users run it on their own servers and many run forks, so any reporting has to be opt-in, anonymous, and easy to inspect. A report that leaked a hostname, a path, or a username would cost more trust than the data is worth.

## Decision

An admin can turn on usage stats. Every 3 days the server sends one snapshot to `aurral.org/api/telemetry`.

- **Asked once.** An admin sees one toast. Showing it counts as asking, so dismissing it leaves stats off for good unless someone turns them on in Settings.
- **A snapshot, not events.** The report describes current state and counts over the last 3 days, read from tables Aurral already keeps. The only new recording is the `seen` set: which pages, device kinds, and Subsonic clients were used. Each is a timestamp per key in the `telemetry:seen` setting, written at most once an hour, and only while stats are on. Turning stats off clears it.
- **No identity.** There is no install ID, and aurral.org stores no IP. Each install sends one report per 3 days, so the reports in any 3-day window count the installs. We give up following one install over time to make anonymity easy to keep.
- **One schema, strict at both ends.** `lib/telemetry.ts` owns the report shape. The backend builds it, and the aurral.org function rejects anything that fails it. Every value is a boolean, a picklist entry, or a count bucket. A new field means a new schema entry, which keeps free text and raw counts out.
- **Buckets, not counts.** Counts are powers-of-ten buckets so a library size or user count can't fingerprint an install.
- **Official builds only.** Like the update check, only release and nightly builds of `lklynet/aurral` send. Forks and dev builds never do.
- **Rows, not counters.** aurral.org keeps each report as a row for 400 days in its own D1 database, `TELEMETRY_DB`. Rows let us ask cross-questions, like how many installs that use deemix use any other download source, which counters can't answer.
- **Public totals.** stats.aurral.org is its own Pages project in `stats/`, so aurral.org writes reports and the stats site only reads them. Its `/api/stats` sums every field inside D1 with `json_tree` and caches the result for an hour, so the Worker never parses reports. It counts the last 3 full days, the window in which each install reports once, and the same window 30 days earlier for the change column on stats.aurral.org.

## Traps

- Lists in `lib/telemetry.ts` mirror lists elsewhere, such as import providers and download sources. A value missing from the lib list is silently left out of the report. Add it there when you add one in the backend.
- Log problem counts come from the app log and ignore the "start fresh" mark, so they reflect what happened, not what the admin last cleared.
- aurral.org can't tell real reports from fake ones. Treat small differences as noise.
