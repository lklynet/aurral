A plugin is a folder with two files, `manifest.json` and `index.js`. The manifest says what the plugin adds. `index.js` is an ES module whose default export has the functions Aurral calls.

Aurral runs each plugin in its own Node process. It starts the process on the first call and stops it after 5 idle minutes. Bundle every package into `index.js`, because Aurral doesn't install any. Node's built-in modules and `fetch` are available.

## How a call works

Aurral calls one function with one object and waits for its answer.

- Every input has `settings` (the values from the plugin's page) and `libraryFolder` (the path of the Library folder).
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
  "importList": null
}
```

| Field            | Use                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | Lowercase letters, numbers, and `-`. The folder has the same name.                                                                                                               |
| `name`           | Shown in Settings, menus, and errors.                                                                                                                                            |
| `version`        | Shown on the plugin's page.                                                                                                                                                      |
| `api`            | `1`.                                                                                                                                                                             |
| `description`    | One or two sentences for the plugin's page.                                                                                                                                      |
| `repository`     | An `https` link. Aurral links to it when the plugin fails, so people report plugin bugs to you.                                                                                  |
| `uses`           | Up to 10 short notes on what the plugin reads or connects to, like `plex.tv` or `Your plays`. Shown before install.                                                              |
| `settings`       | Fields for the plugin's page. `type` is `text`, `password`, `number`, or `boolean`. `required` fields must be filled before the plugin runs. `help` adds a line under the field. |
| `test`           | `true` when `index.js` exports `test`. The plugin's page then shows a **Test** button.                                                                                           |
| `actions`        | Menu items. See [Actions](#actions).                                                                                                                                             |
| `events`         | Events the plugin receives. See [Events](#events).                                                                                                                               |
| `downloadSource` | `{ "albums": false }` for a track source, `{ "albums": true }` to also download albums. See [Download sources](#download-sources).                                               |
| `importList`     | `{ "label": "Bandcamp", "hosts": ["bandcamp.com"] }` to import playlists from links on those hosts. See [Import lists](#import-lists).                                           |

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

Each manifest entry needs its function: `test`, `actions.<id>`, `events["<event>"]`, `downloadSource.search` and the rest, or `importList.fetch`. A missing function counts as broken.

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

List events in the manifest and export a function for each under `events`. Aurral queues every event and retries a failed one 5 times with a growing delay, so a slow or failing plugin never holds Aurral up. An event has 1 minute. Its answer is ignored.

| Event               | When                                      | Receives                                                                                                                                                             |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playlist.changed`  | A playlist or flow's M3U file changed     | `playlist` as in actions, plus `title`: the name the M3U file gives it, which media servers show                                                                     |
| `playlist.removed`  | A playlist or flow's M3U file was removed | `playlist.title`                                                                                                                                                     |
| `track.played`      | Someone played a track                    | `user` (`id`, `username`), `track` (`id`, `title`, `artist`, `album`, `durationMs`, `artistMbid`, `albumMbid`, `trackMbid`), `playedAt` (milliseconds), and `source` |
| `download.finished` | A download was filed in the Library       | `track` (`title`, `artist`, `album`, `mbid`, `path`) and `source`                                                                                                    |
| `notification`      | Aurral sent a notification                | `kind` (`discovery.updated`, `flow.done`, `request.made`, or `request.available`), `title`, `message`, and details like `album` or `flow`                            |

Every event also receives `event`, its name.

## Download sources

A download source joins the other download sources. Admins set its priority, and sources with a lower number are searched first. Aurral matches results to the request, gives the plugin an empty `directory` for each download, and checks every file the same way it checks other sources. A file that doesn't match goes to the review queue or is denied.

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

`search` receives `track`: `artist`, `title`, `album`, `durationMs`, `artistMbid`, `albumMbid`, `releaseMbid`, `trackMbid`, `releaseYear`, `trackNumber`, and `discNumber`. Any of them can be `null`. Return up to 50 results. Each needs `id`, `title`, and `artist`. `album`, `durationMs`, `format`, and `bitrate` (in kbps) help Aurral choose. Put anything `download` needs in `data`. Aurral passes it back unchanged and drops other fields.

`download` receives the chosen `result` and an empty `directory`. Save one audio file inside it and return `{ path }`, relative to `directory` or absolute. A path outside `directory` is refused. A search has 1 minute and a download has 30 minutes.

### Albums

Set `"downloadSource": { "albums": true }` and export `searchAlbum` and `downloadAlbum` to download whole albums.

`searchAlbum` receives `album`: `artist`, `title`, `releaseMbid`, `releaseGroupMbid`, and `tracks`, each with `title`, `trackNumber`, `discNumber`, and `durationMs`. Return up to 50 results. Each needs `id`, `title`, and `artist`, and can have `year`, `trackCount`, `format`, `bitrate`, and `data`. Aurral tries results whose title matches the album.

`downloadAlbum` receives `result`, `album`, and an empty `directory`. Save the album's audio files anywhere inside `directory` and return nothing. Aurral matches the files to the release's tracks and files each one.

### Long downloads

`download` and `downloadAlbum` can return `{ pending: "<id>" }` instead, for a client that downloads on its own, like a torrent client. Export `status` too. Aurral calls `status({ id, directory })` every 15 seconds until it returns `{ done: true }`. For a track, include `path`. Return `{ done: false }` while it's still downloading, and throw if it failed. Copy or hardlink the finished files into `directory`. A download that doesn't finish within a day fails.

## Import lists

```json
{ "importList": { "label": "Bandcamp", "hosts": ["bandcamp.com"] } }
```

The plugin shows as a source in **Import playlist**. A user pastes a link on one of the `hosts` (subdomains count) and Aurral calls `importList.fetch({ url })`. Return `{ name, artworkUrl, tracks }`. Each track needs `artist` and `title` and can have `album`, `durationMs`, and `mbid`. Return up to 5000 tracks. When the user keeps the playlist synced, Aurral calls `fetch` again on its schedule. A fetch has 2 minutes.

## Install and update

People install a plugin by putting its folder in the `plugins` folder of their data folder, or by pasting a link to a `.zip` in **Settings > Plugins**. The zip holds `manifest.json` and `index.js`, at its root or in one folder. Publish each version as a release asset, so people can update from the same link.
