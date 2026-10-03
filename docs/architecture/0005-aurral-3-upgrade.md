# Aurral 3.0 upgrade

Status: Accepted

## Problem

Aurral 2.x carries code for every version it can upgrade from: startup migrations, column patches, fallbacks for old settings and paths, and names from designs that no longer exist. It runs on every start because a user can upgrade from any older version.

3.0 deletes that code. It is safe only if no database reaches 3.0 without those migrations, and if 3.0 never starts on old configuration that it no longer reads.

## Decision

### The stamp

The last 2.x releases check whether their database finished every 2.x migration that 3.0 relies on. It stores the result in the `aurral3Readiness` setting, and shows it in **Settings > System > Aurral 3.0**. A database is stamped when that setting says `ready` and the schema version is 4.

### Start order

Before 3.0 creates or changes any table, it checks the configuration and the database. If a check fails, it logs why and exits without writing anything.

1. `WEEKLY_FLOW_FOLDER` or `PLAYLIST_FOLDER` is set. Set `DOWNLOAD_FOLDER` instead.
2. The data folder is `/app/backend/data`. Mount it at `/config` instead.
3. The database has tables but is not a stamped schema 4 database. Run the `:2` image until **Settings > System > Aurral 3.0** shows ready, then start 3.0.
4. The schema version is newer than 3.0 knows. Aurral does not run on a database from a newer release.

`AUTH_USER` and `AUTH_PASSWORD` log a warning and are ignored. The stamp requires an account, so the single password no longer protects anything.

A database without tables is a fresh install. 3.0 creates schema 5 directly.

### Backup and migration

A stamped schema 4 database gets one migration to schema 5. Before it runs, Aurral copies the database with `VACUUM INTO` to `aurral-2-backup-<time>.db` next to `aurral.db`. The migration runs in one transaction, so a failure leaves the database at schema 4 and 3.0 exits. 2.x cannot read schema 5. To go back to 2.x, restore the backup.

The migration:

- renames tables, columns, settings keys, queues, tasks, operation kinds, the permission, and the webhook event to their current names
- moves static playlist jobs into the Library, as [0006](0006-static-playlist-download-jobs.md) describes
- deletes the columns, settings, and rows that only older code read
- moves playlist artwork and sidecar files out of `aurral-weekly-flow`

### After 3.0

The `CREATE TABLE` statements describe schema 5 in full. Later releases add numbered migrations from schema 5 upward. They do not patch columns on every start.

A column that a 2.x release adds after the first stamping release must also be added by the schema 5 migration, or a database stamped by the earlier release would miss it.

## Consequences

- Every user upgrades through a stamping 2.x release. Releases publish a `:2` image tag for this.
- 3.0 removes the readiness check, the deprecation warnings, and every 2.x migration, including the ones that set up the stamp.
- A downgrade needs the backup. Changes made in 3.0 after the upgrade are lost when the backup is restored.
