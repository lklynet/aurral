**Plugins are in beta.** This API can change in any Aurral release until plugins reach a stable release, and a change can break plugins that work today. Expect to update your plugin when Aurral changes.

A plugin is a folder with two files, `manifest.json` and `index.js`. The manifest says what the plugin adds. `index.js` is an ES module whose default export has the functions Aurral calls.

A plugin works in two directions. Aurral calls it from menus, on events, on a schedule, as a download source, or to import a playlist. With `apiAccess`, the plugin can also call Aurral's API and do anything an admin can do in the app.

Aurral runs each plugin in its own Node process. It starts the process on the first call and stops it after 5 idle minutes. Bundle every package into `index.js`, because Aurral doesn't install any. Node's built-in modules and `fetch` are available.

## How a call works

Aurral calls one function with one object and waits for its answer.

- Every input has `settings` (the values from the plugin's page), `libraryFolder` (the path of the Library folder), and `dataFolder` (a folder for the plugin's own files, kept between calls and updates and deleted when the plugin is removed). With `apiAccess`, it also has `api`. See [Aurral's API](#aurrals-api).
- Return the answer the function's section describes. Aurral checks every answer. An answer it can't read counts as a failure and the error names the field.
- Throw an `Error` to fail a call. Its message shows in Aurral with the plugin's name. Thrown errors are expected, for example when a service is down.
- A crash, a timeout, or an answer Aurral can't read counts as broken. After 3 in a row, Aurral turns the plugin off.
- Anything the plugin writes to the console goes to the Aurral log under `plugin:<id>`.

## manifest.json

```json
{
  "id": "send-to-box",
  "name": "Send to Box",
  "version": "1.0.0",
  "api": 1,
  "description": "Sends playlists to Box.",
  "repository": "https://github.com/you/aurral-send-to-box",
  "uses": ["box.example.com"],
  "settings": [
    { "key": "url", "label": "Box URL", "type": "text", "required": true },
    { "key": "token", "label": "Token", "type": "password", "required": true }
  ],
  "test": true,
  "actions": [{ "id": "send", "label": "Send to Box", "target": "playlist" }],
  "events": ["playlist.changed"],
  "downloadSource": null,
  "importList": null,
  "schedule": null,
  "apiAccess": false
}
```

| Field            | Use                                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | Lowercase letters, numbers, and `-`. The folder has the same name.                                                                                                                                                                                               |
| `name`           | Shown in Settings, menus, and errors.                                                                                                                                                                                                                            |
| `version`        | Shown on the plugin's page.                                                                                                                                                                                                                                      |
| `api`            | `1`.                                                                                                                                                                                                                                                             |
| `description`    | One or two sentences for the plugin's page.                                                                                                                                                                                                                      |
| `repository`     | An `https` link. Aurral links to it when the plugin fails, so people report plugin bugs to you.                                                                                                                                                                  |
| `uses`           | Up to 10 short notes on what the plugin reads or connects to, like `plex.tv` or `Your plays`. Shown before install.                                                                                                                                              |
| `settings`       | Fields for the plugin's page. `type` is `text`, `password`, `number`, or `boolean`. `required` fields must be filled before the plugin runs. A `boolean` starts as `false`. `help` adds a line under the field.                                                  |
| `test`           | `true` when `index.js` exports `test`. The plugin's page then shows a **Test** button.                                                                                                                                                                           |
| `actions`        | Menu items. See [Actions](#actions).                                                                                                                                                                                                                             |
| `events`         | Events the plugin receives. See [Events](#events).                                                                                                                                                                                                               |
| `downloadSource` | `{}` for a track source. Add `"albums": true` to download albums, `"tracks": false` for an album-only source, `"files": true` to download one track from an album, and `"upgrades": true` to supply quality upgrades. See [Download sources](#download-sources). |
| `importList`     | `{ "label": "Bandcamp", "hosts": ["bandcamp.com"] }` to import playlists from links on those hosts. See [Import lists](#import-lists).                                                                                                                           |
| `schedule`       | `"15m"`, `"1h"`, `"6h"`, or `"24h"` to run `scheduled` that often. See [Schedules](#schedules).                                                                                                                                                                  |
| `apiAccess`      | `true` to get a key to Aurral's API. See [Aurral's API](#aurrals-api).                                                                                                                                                                                           |

Each capability can be turned off on its own in **Settings > Plugins**, so keep them independent.

## index.js

```js
export default {
  async test({ settings }) {
    const response = await fetch(`${settings.url}/ping`);
    if (!response.ok) throw new Error(`Box answered ${response.status}`);
    return { message: "Connected to Box" };
  },
  actions: {
    async send({ settings, user, playlist }) {
      await fetch(`${settings.url}/playlists`, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ name: playlist.name, tracks: playlist.tracks }),
      });
      return { message: `Sent ${playlist.tracks.length} tracks to Box` };
    },
  },
  events: {
    async "playlist.changed"({ settings, playlist }) {
      await fetch(`${settings.url}/playlists/${playlist.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ name: playlist.title, tracks: playlist.tracks }),
      });
    },
  },
};
```

Each manifest entry needs its function: `test`, `actions.<id>`, `events["<event>"]`, `downloadSource.search` and the rest, `importList.fetch`, or `scheduled`. A missing function counts as broken.

## Test

`test({ settings, libraryFolder })` checks the plugin's settings, usually by calling its service. Return `{ message }` or nothing. Throw to report a problem. It has 30 seconds.

## Actions

```json
{ "id": "send", "label": "Send to Box", "target": "playlist", "admin": false, "background": false }
```

An action is a menu item. `target` sets where it shows and what it receives:

| `target`   | Shows in                | Receives   |
| ---------- | ----------------------- | ---------- |
| `playlist` | Playlist and flow menus | `playlist` |
| `album`    | Library album menus     | `album`    |
| `artist`   | Library artist menus    | `artist`   |
| `track`    | Library track menus     | `tracks`   |

Every action also receives `user`: the `id`, `username`, and `role` of the person who chose it. Set `"admin": true` to show it only to admins.

Return `{ message }` to show it to the user, or nothing. An action has 2 minutes. Set `"background": true` for longer work: the user sees that it started, and its message shows when it finishes, up to 30 minutes later.

**playlist**: `id`, `name`, `kind` (`playlist` or `flow`), `file` (the path of its M3U file, or `null`), and `tracks`. Each track has `path`, `title`, `artist`, and when known `album`, `durationMs`, and `mbid`.

**album**: `id`, `title`, `artist`, `mbid`, `releaseGroupMbid`, `year`, and `tracks`.

**artist**: `id`, `name`, `mbid`, and `albums`, each with `id`, `title`, `mbid`, and `year`.

**tracks**: each has `id`, `path` (or `null` when there's no file), `title`, `artist`, `album`, `durationMs`, `mbid`, `trackNumber`, and `discNumber`. Unknown values are `null`.

## Events

List events in the manifest and export a function for each under `events`. Aurral queues every event and hands it to the plugin without waiting for the answer, so a slow plugin never holds Aurral up. An event has 10 seconds, isn't retried, and its answer is ignored. A crash or timeout still counts as broken.

| Event               | When                                      | Receives                                                                                                                                                             |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playlist.changed`  | A playlist or flow's M3U file changed     | `playlist` as in actions, plus `title`: the name the M3U file gives it, which media servers show                                                                     |
| `playlist.removed`  | A playlist or flow's M3U file was removed | `playlist.title`                                                                                                                                                     |
| `track.played`      | Someone played a track                    | `user` (`id`, `username`), `track` (`id`, `title`, `artist`, `album`, `durationMs`, `artistMbid`, `albumMbid`, `trackMbid`), `playedAt` (milliseconds), and `source` |
| `download.finished` | A download was filed in the Library       | `track` (`title`, `artist`, `album`, `mbid`, `path`) and `source`                                                                                                    |
| `notification`      | Aurral sent a notification                | `kind` (`discovery.updated`, `flow.done`, `request.made`, `request.available`, or `artist.added`), `title`, `message`, and details like `album`, `artist`, or `flow` |

Every event also receives `event`, its name.

## Schedules

Set `"schedule"` and export `scheduled`. Aurral calls `scheduled({ settings, libraryFolder, dataFolder })` that often, starting within 15 minutes of the plugin being turned on. A run has 10 minutes and its answer is ignored. A failed run isn't retried, because the next one comes on schedule. Keep what a run needs to remember, like the last item it saw, in `dataFolder`.

## Aurral's API

Set `"apiAccess": true` to call Aurral's API. Every input then has `api` with `url`, the base of the API, and `key`. Send the key in the `X-Api-Key` header:

```js
export default {
  async scheduled({ api, dataFolder }) {
    const response = await fetch(`${api.url}/library/recent`, {
      headers: { "X-Api-Key": api.key },
    });
    if (!response.ok) throw new Error(`Aurral answered ${response.status}`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${dataFolder}/recent.json`, JSON.stringify(await response.json()));
  },
};
```

The key acts as an admin, so the plugin can do anything an admin can do in Aurral, like creating playlists, requesting albums, starting flows, or changing settings. People see this before they install, and can turn it off on the plugin's page. The key works only while the plugin is on or being tested, and stops working in safe mode. The [endpoint reference](https://docs.aurral.org/api/endpoints/) lists every route. The [app API contract](https://docs.aurral.org/api/app-contract/) lists the ones that stay stable between releases.

## Download sources

A download source joins the other download sources. Admins set its priority, and sources with a lower number are searched first. Aurral matches results to the request, gives the plugin an empty `directory` for each download, and checks every file the same way it checks other sources. A file that doesn't match goes to the review queue or is denied. Manual Search lists the results of `search`, or of `searchAlbum` when the plugin only downloads albums, for a person to pick one.

```js
export default {
  downloadSource: {
    async search({ settings, track }) {
      return [
        {
          id: "123",
          title: "Song",
          artist: "Artist",
          album: "Album",
          durationMs: 215000,
          format: "flac",
          data: { url: "https://example.com/123.flac" },
        },
      ];
    },
    async download({ settings, result, directory }) {
      const response = await fetch(result.data.url);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(`${directory}/123.flac`, Buffer.from(await response.arrayBuffer()));
      return { path: "123.flac" };
    },
  },
};
```

`search` receives `track` and `upgrade`. `track` has `artist`, `title`, `album`, `durationMs`, `artistMbid`, `albumMbid`, `releaseMbid`, `trackMbid`, `releaseYear`, `trackNumber`, and `discNumber`. Any of them can be `null`. Return up to 50 results. Each needs `id`, `title`, and `artist`. `album`, `durationMs`, `format`, and `bitrate` (in kbps) help Aurral choose. Put anything `download` needs in `data`. Aurral passes it back unchanged and drops other fields.

`download` receives the chosen `result` and an empty `directory`. Save one audio file inside it and return `{ path }`, relative to `directory` or absolute. A path outside `directory` is refused. A search has 1 minute and a download has 30 minutes.

### Albums

Set `"downloadSource": { "albums": true }` and export `searchAlbum` and `downloadAlbum` to download whole albums.

`searchAlbum` receives `album` and `upgrade`. `album` has `artist`, `title`, `releaseMbid`, `releaseGroupMbid`, and `tracks`, each with `title`, `trackNumber`, `discNumber`, and `durationMs`. Return up to 50 results. Each needs `id`, `title`, and `artist`, and can have `year`, `trackCount`, `format`, `bitrate`, and `data`. Aurral tries results whose title matches the album.

`downloadAlbum` receives `result`, `album`, and an empty `directory`. Save the album's audio files anywhere inside `directory` and return nothing. Aurral matches the files to the release's tracks and files each one.

Add `"tracks": false` when the plugin can only download albums, like a torrent source, and leave out `search` and `download`. Aurral then gets a single track from its album: it searches for the album, downloads it, and picks the track's file by its tags.

### Part of an album

Set `"files": true` and export `listFiles` and `keepFiles` when the plugin can download part of an album. When `downloadAlbum` returns `pending`, Aurral calls `listFiles({ id })` until it returns the album's files, each with `path` and `size` in bytes. Return `null` while the files aren't known yet. Aurral then picks the files it wants by their names and calls `keepFiles({ id, paths })` once, so the plugin downloads only those files. For tracks of an album, it keeps them only when the names show the whole release. When Aurral can't tell, `paths` holds every file. The plugin can wait for `keepFiles` before it downloads anything. `status` then puts only the kept files in `directory`.

### Upgrades

Set `"upgrades": true` to supply quality upgrades. `upgrade` is `null` for a track the user doesn't have yet. For an upgrade, it is `{ currentTier }`, the quality of the user's file: `flac-hires`, `flac-standard`, `mp3-320`, `m4a-320`, `mp3-256`, `m4a-256`, `mp3-192`, `m4a-192`, `mp3-128`, `m4a-128`, or `null` when Aurral doesn't know it. Return only results that are better. Aurral checks every file it downloads, so an upgrade never replaces a file with a worse one.

### Long downloads

`download` and `downloadAlbum` can return `{ pending: "<id>" }` instead, for a client that downloads on its own, like a torrent client. Export `status` too. Aurral calls `status({ id, directory })` every 15 seconds until it returns `{ done: true }`. When `download` returned it, include `path`. Return `{ done: false }` while it's still downloading, and throw if it failed. Copy or hardlink the finished files into `directory`. A download that doesn't finish within a day fails.

Export `discard` too. Aurral calls `discard({ id })` when it no longer wants a pending download: the user cancelled it, it failed, or its files didn't match. Remove what the client still downloads, and leave a finished download alone when the client keeps it, for example to seed.

### Clients that file their own downloads

A client that files finished album downloads in its own folder, like Lidarr, can leave them there. When the album is done, return `{ done: true, filed: <count> }` from `status`, with the number of audio files the client has for it, and put nothing in `directory`. No paths: the folder has to be one of the user's read-only folders, which they add in **Settings > Library**, and Aurral finds the album there through its Library index.

Aurral waits until it has indexed that many files for the album, scans the read-only folders once if file events don't arrive, and fails the download if the album never shows up. It checks the files like any download, uses the ones that match where they are, and never moves, changes, or deletes them. A file that doesn't match is skipped instead of going to the review queue. Only album downloads can be filed, and an upgrade can't, because Aurral replaces the file it upgrades.

## Import lists

```json
{ "importList": { "label": "Bandcamp", "hosts": ["bandcamp.com"] } }
```

The plugin shows as a source in **Import playlist**. A user pastes a link on one of the `hosts` (subdomains count) and Aurral calls `importList.fetch({ url })`. Return `{ name, artworkUrl, tracks }`. Each track needs `artist` and `title` and can have `album`, `durationMs`, and `mbid`. Return up to 5000 tracks. When the user keeps the playlist synced, Aurral calls `fetch` again on its schedule. A fetch has 2 minutes.

Add `"sync": false` when a link's playlist never changes, such as a playlist the plugin builds once. Aurral then imports it once and doesn't offer sync.

## Install and update

People install plugins by pasting a link in **Settings > Plugins**, or by putting a plugin's folder in the `plugins` folder of their data folder.

A link can be a GitHub repo, like `https://github.com/you/aurral-plugins`. Aurral uses the latest release: its first `.zip` asset when it has one, or else its source. A repo without releases installs from its default branch. Aurral finds every folder with a `manifest.json`, at the root or up to two folders down, and lets people choose which to install. Each plugin folder holds everything it needs. A link can also point straight at a `.zip`.

**Update** downloads the same link again and replaces the plugin's folder. Publish a release for each version, and attach a `.zip` when `index.js` has to be built first.
