# Monitoring rules

Status: Accepted

## Problem

Aurral copied Lidarr's monitor modes: all, future, latest, and first. They cover a few cases. They never take singles, live albums, or a deluxe edition, they ignore the songs people actually play, and a deleted album came back the next day, so Aurral had to refuse to delete it. Users manage most artists the same way and a few differently, and they need to change their minds without re-saving every artist.

## Decision

An Aurral artist is monitored or not. A monitored artist either follows the live default rules or has its own. Lidarr artists keep Lidarr's modes and Lidarr does their monitoring.

- **Rules.** `catalog` (`none`, `all`, `since`, `latest`), `sinceYear`, `latestCount`, `newReleases`, `types`, `extraTypes`, `edition`, and `topTracks`. `backend/services/aurralMonitoring.ts` validates and applies them. Rules that take nothing are rejected.
- **Storage.** `library_management.monitor_rules` holds `{ default: true, catalogAt, newSince }` or `{ default: false, rules, catalogAt, newSince }`. `NULL` means not monitored. `monitor_mode` and the artist's metadata still carry the nearest old mode, so an older build that reads them after a downgrade keeps working. The upsert clears `monitor_rules` when the manager or mode changes without new rules, so stale rules never come back.
- **Time.** The back catalogue is what was out at `catalogAt`, so "latest 3" stays three releases. New releases are those dated after `newSince`. Saving the same rules keeps both times, and keeping new releases on keeps `newSince`, so a re-save never drops a release that came out in between.
- **Live defaults.** The defaults are one settings row, `monitoringDefaults`, with `updatedAt` and `newReleasesSince`. An artist that follows them takes the later of its own times and the defaults' times, which is the same as re-saving every follower at the moment the defaults change. Saving the defaults queues a reconciliation instead of planning every artist in the request.
- **Covered releases.** A release that is not a studio album is skipped when every recording on it is in the Library or on an earlier release in the same plan. Studio albums sort first so their recordings count. This keeps singles and EPs from duplicating album tracks without a setting for it.
- **Exclusions.** Deleting an album, or a track file, adds a row to `library_monitoring_exclusions`. Plans and acquisitions skip excluded albums and tracks. A user request, or **Allow again**, clears the row. This replaces refusing to delete an album of a monitored artist.
- **Keep this file.** `library_tracks.keep_file` stops quality upgrades for a track's file and cancels one in progress. It does not change monitoring.
- **Races.** A queued acquisition carries a token of the artist's effective monitoring. It does nothing when the token no longer matches, so a later disable or change of rules wins.

## Alternatives

Copying the defaults into each artist when it is monitored is simpler, but changing the defaults would then mean rewriting every artist and losing which ones the user had customized. Keeping the modes and adding options to them keeps every limit of the modes. Unmonitoring a deleted album instead of excluding it needs an album row, which deleting removes.

## Risks

Top tracks come from Last.fm or Deezer, matched by artist name, so an artist that shares a name can bring the wrong songs. The expanded edition depends on MusicBrainz listing the deluxe release under the album.
