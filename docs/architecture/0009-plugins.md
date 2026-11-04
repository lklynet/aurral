# Plugins

Status: Accepted

## Problem

Aurral removed most of its integrations to keep core small and reliable, and users still want them back, along with new ones for the clients they run. Integrations that live in core slow it down and break with other apps' updates. Arbitrary code from other people also makes bug reports hard: a crash, a hang, or a bad value from a plugin looks like an Aurral bug.

## Decision

A plugin is a folder in `<data dir>/plugins/<id>` with a `manifest.json` and a bundled `index.js`. It fills typed capabilities that Aurral calls. It cannot hook into Aurral's internals.

- **Capabilities, not hooks.** API 1 has playlist menu actions and a track download source. The manifest declares them, along with the settings Aurral renders on the plugin's page. Plugins ship no frontend code, so Aurral draws every menu item and settings row, and a page that breaks is Aurral's bug.
- **One process per plugin, per Aurral process.** `pluginHost.ts` forks `pluginRunner.ts`, which imports `index.js` and answers calls over IPC. The main process runs actions, and the downloads worker runs download sources, so each forks its own copy. A process starts on its first call and stops after 5 idle minutes. It gets a 256 MB heap, a short list of environment variables, and its stdout and stderr go to the app log under `plugin:<id>`.
- **One boundary.** `callPlugin` checks every answer with a Valibot schema. A failure before that check is the plugin's: its error carries the plugin's name in the UI and its id in the log, and its page shows the last error with the manifest's `repository` link. A failure after the check is Aurral's.
- **Broken plugins turn off.** A crash, a timeout, a failed start, or an answer the schema rejects counts as broken. After three in a row, Aurral turns the plugin off and records why. An error the plugin throws, such as its service being down, never counts, because that is the plugin working.
- **State in SQLite.** The `plugins` table holds `enabled`, `priority`, encrypted `settings`, `last_error`, and a snapshot of the manifest. Opening **Settings > Plugins** and starting the server rescan the folder and update the snapshot. Worker processes read only the table, so the download pipeline's synchronous source list stays one query. The snapshot is parsed again when read, as in 0007.
- **Off until turned on.** A new folder never runs until an admin turns it on. Actions and sources show only while the plugin is on and its required settings are filled in.
- **Safe mode.** The `pluginSafeMode` setting or `AURRAL_SAFE_MODE` makes every plugin inactive without changing their own settings. It is the first step for telling a plugin bug from an Aurral bug.
- **Download sources are tracks only.** A source's id is `plugin:<id>`. It searches, Aurral matches the results with the `plugin` capabilities in `candidateNormalizer.ts`, the plugin downloads into an empty staging folder Aurral gives it, and Aurral checks and commits the file like any other source. A path outside that folder is refused.

## Traps

- Plugins are not sandboxed. A plugin runs as the Aurral user and can read the data dir. The env filter only keeps Aurral's secrets out of its environment by accident. The docs tell users to trust plugins like Docker images.
- Turning a plugin off stops its process only in the process that saved the change. Another process keeps its copy until it goes idle, but never calls it, because every call reads the table first.
- Changing a capability's input or output shape breaks plugins. Add a field, or raise `PLUGIN_API_VERSION` and keep reading the old version.
