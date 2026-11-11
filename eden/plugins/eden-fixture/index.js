import { appendFile, copyFile, readFile } from "node:fs/promises";
import path from "node:path";

const same = (left, right) =>
  String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();

async function note(input, call, details = {}) {
  await appendFile(
    path.join(input.dataFolder, "calls.jsonl"),
    `${JSON.stringify({ call, at: Date.now(), ...details })}\n`,
  );
  if (input.settings.fail) throw new Error("Eden Fixture was told to fail");
}

const releases = async ({ world }) =>
  JSON.parse(await readFile(path.join(world, "manifest.json"), "utf8"));

const action = (target) => async (input) => {
  await note(input, `action:${target}`, {
    user: input.user,
    [target]: input[target] ?? input.tracks,
  });
  return { message: `Eden Fixture noted the ${target}` };
};

const event = (name) => async (input) => {
  const { settings, libraryFolder, dataFolder, api, ...payload } = input;
  await note(input, `event:${name}`, payload);
};

export default {
  async test(input) {
    await note(input, "test");
    return { message: `${input.settings.greeting || "Hello"} from Eden` };
  },
  actions: {
    playlist: action("playlist"),
    album: action("album"),
    artist: action("artist"),
    track: action("track"),
  },
  events: {
    "playlist.changed": event("playlist.changed"),
    "playlist.removed": event("playlist.removed"),
    "track.played": event("track.played"),
    "download.finished": event("download.finished"),
    notification: event("notification"),
  },
  async scheduled(input) {
    const response = await fetch(`${input.api.url}/library/recent`, {
      headers: { "X-Api-Key": input.api.key },
    });
    await note(input, "scheduled", { aurralAnswered: response.status });
  },
  downloadSource: {
    async search(input) {
      await note(input, "search", { track: input.track });
      const found = (await releases(input.settings)).flatMap((release) =>
        same(release.artist, input.track.artist)
          ? release.files
              .filter((file) => same(file.title, input.track.title))
              .map((file) => ({
                id: `${release.id}/${file.name}`,
                title: file.title,
                artist: release.artist,
                album: release.album,
                format: "flac",
                data: { release: release.name, file: file.name },
              }))
          : [],
      );
      return found.slice(0, input.settings.limit || 50);
    },
    async download(input) {
      const { release, file } = input.result.data;
      await note(input, "download", { release, file });
      await copyFile(
        path.join(input.settings.world, "releases", release, file),
        path.join(input.directory, file),
      );
      return { path: file };
    },
    async searchAlbum(input) {
      await note(input, "searchAlbum", { album: input.album });
      return (await releases(input.settings))
        .filter(
          (release) =>
            same(release.artist, input.album.artist) && same(release.album, input.album.title),
        )
        .map((release) => ({
          id: release.id,
          title: release.album,
          artist: release.artist,
          year: Number(release.date.slice(0, 4)) || null,
          trackCount: release.files.length,
          format: "flac",
          data: { release: release.name },
        }));
    },
    async downloadAlbum(input) {
      const { release } = input.result.data;
      await note(input, "downloadAlbum", { release });
      const found = (await releases(input.settings)).find((entry) => entry.name === release);
      for (const file of found?.files ?? []) {
        await copyFile(
          path.join(input.settings.world, "releases", release, file.name),
          path.join(input.directory, file.name),
        );
      }
    },
  },
  importList: {
    async fetch(input) {
      await note(input, "importList", { url: input.url });
      const tracks = (await releases(input.settings)).slice(0, 4).flatMap((release) =>
        release.files.slice(0, 3).map((file) => ({
          artist: release.artist,
          title: file.title,
          album: release.album,
        })),
      );
      return { name: "Eden import", artworkUrl: null, tracks };
    },
  },
};
