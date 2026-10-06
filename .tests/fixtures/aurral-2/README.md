# Aurral 2 fixture databases

Each `.sql` file is a dump of a database written by Aurral 2 code, from commit `a0ed5868`. The matching `.files.json` lists the Downloads Folder files that the database refers to. `loadAurral2Fixture` in `.tests/helpers/aurral2Fixture.js` creates both under a temporary folder and replaces `__ROOT__` with it.

- `stamped.sql` is a 2.x install marked ready for 3.0. It has a flow, an imported static playlist that owns finished, queued, failed, reused, and unmatched jobs plus an upgrade job, a playlist that references Library jobs, jobs of a deleted playlist, queued Honker work, an account from before sign-in identities, and a cover cached from the old cover host.
- `upgraded-from-1.sql` started as a database written by `v1-final` with 1.x flows and settings, then ran the 2.x startup tasks until it was marked ready.
- `review.sql` has a Downloads Folder file that the 2.x migration held for review, so it is not marked ready.

The search index tables are left out. Aurral rebuilds them on start.
