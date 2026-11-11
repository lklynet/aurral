import assert from "node:assert/strict";
import * as v from "valibot";
import { afterAll, test } from "vite-plus/test";
import type { ServiceName } from "../services/index.ts";
import { local } from "../services/service.ts";
import { LOGIN } from "../state.ts";
import { api, aurralRows, getJson, has, ports, until, worldRelease } from "./eden.ts";

const SETTINGS_SOURCES = ["ytdlp", "slskd", "nzbget", "sabnzbd", "qbittorrent"] as const;
const PLUGIN_SOURCES = ["lidarr", "eden-fixture"] as const;
type Source = (typeof SETTINGS_SOURCES)[number] | (typeof PLUGIN_SOURCES)[number];

const NEEDS: Record<Source, ServiceName[]> = {
  ytdlp: [],
  slskd: ["slskd"],
  nzbget: ["nzbget"],
  sabnzbd: ["sabnzbd"],
  qbittorrent: ["qbittorrent"],
  lidarr: ["lidarr"],
  "eden-fixture": ["plugins"],
};
const available = (source: Source) => has(...NEEDS[source]);

// Leaves one download source on, so a journey proves that source and no other.
async function leaveOn(chosen: (source: Source) => boolean) {
  await api.post("/settings", {
    integrations: Object.fromEntries(
      SETTINGS_SOURCES.filter(available).map((source) => [source, { enabled: chosen(source) }]),
    ),
  });
  for (const plugin of PLUGIN_SOURCES.filter(available)) {
    await api.put(`/plugins/${plugin}`, { enabled: chosen(plugin) });
  }
}

afterAll(() => leaveOn(() => true));

const JOURNEYS: { source: Source; recordedAs: string; client?: string }[] = [
  { source: "ytdlp", recordedAs: "ytdlp" },
  { source: "nzbget", recordedAs: "usenet", client: "nzbget" },
  { source: "sabnzbd", recordedAs: "usenet", client: "sabnzbd" },
  { source: "qbittorrent", recordedAs: "qbittorrent" },
  { source: "slskd", recordedAs: "slskd" },
  { source: "lidarr", recordedAs: "plugin:lidarr" },
  { source: "eden-fixture", recordedAs: "plugin:eden-fixture" },
];

JOURNEYS.forEach(({ source, recordedAs, client }, index) => {
  test.skipIf(!available(source))(`a requested album downloads through ${source}`, async () => {
    const release = worldRelease(index);
    await leaveOn((candidate) => candidate === source);
    await api.post("/library/albums/request", {
      albumMbid: release.id,
      albumName: release.album,
      artistMbid: release.artistId,
      artistName: release.artist,
    });
    const jobs = await until(
      `${release.name} to finish downloading`,
      async () => {
        const found = aurralRows(
          "SELECT status, download_source, download_client, error FROM download_jobs WHERE album_name = ? AND artist_name = ?",
          release.album,
          release.artist,
        );
        const settled = found.every((job) => job.status === "done" || job.status === "failed");
        return found.length >= release.files.length && settled && found;
      },
      280_000,
    );
    assert.deepEqual(
      jobs.filter((job) => job.status !== "done"),
      [],
    );
    const carriers = jobs.filter((job) => job.download_source);
    assert.ok(carriers.length > 0);
    for (const job of carriers) {
      assert.equal(job.download_source, recordedAs);
      if (client) assert.equal(job.download_client, client);
    }
  });
});

test.skipIf(!has("webhooks", "gotify"))(
  "the webhook and Gotify hear a request made and filled",
  async () => {
    const { album, artist } = worldRelease(0);
    const notices = [
      `Album requested: ${album} by ${artist}`,
      `Album available: ${album} by ${artist}`,
    ];
    await until("the webhook to hear both", async () => {
      const received = v.parse(
        v.array(v.looseObject({ body: v.string() })),
        await getJson(`${local(ports.webhookSink)}/requests`),
      );
      return notices.every((notice) => received.some(({ body }) => body.includes(notice)));
    });
    await until("Gotify to show both", async () => {
      const { messages } = v.parse(
        v.object({ messages: v.array(v.looseObject({ message: v.string() })) }),
        await getJson(`${local(ports.gotify)}/message?limit=200`, {
          headers: {
            authorization: `Basic ${Buffer.from(`${LOGIN.username}:${LOGIN.password}`).toString("base64")}`,
          },
        }),
      );
      return notices.every((notice) => messages.some(({ message }) => message.includes(notice)));
    });
  },
);
