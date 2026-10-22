import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import {
  invalidateAllDownloadStatusesCache,
  registerDownloads,
} from "../../backend/routes/library/handlers/downloads.ts";
import { lidarrClient } from "../../backend/services/lidarrClient.ts";

const routes = new Map();
registerDownloads({
  post: () => {},
  get: (path, ...handlers) => routes.set(`GET ${path}`, handlers.at(-1)),
});

test("a queue item without a remaining size reports no progress", async () => {
  vi.spyOn(lidarrClient, "isConfigured").mockReturnValue(true);
  vi.spyOn(lidarrClient, "isCircuitOpen").mockReturnValue(false);
  vi.spyOn(lidarrClient, "getQueue").mockResolvedValue([
    { id: 1, status: "queued", size: 100 },
    { id: 2, status: "downloading", size: 100, sizeleft: 25 },
  ]);
  vi.spyOn(lidarrClient, "getHistory").mockResolvedValue({ records: [] });
  vi.spyOn(lidarrClient, "request").mockResolvedValue([]);
  invalidateAllDownloadStatusesCache();

  let body;
  await routes.get("GET /downloads")(
    {},
    {
      json(value) {
        body = value;
      },
    },
  );
  assert.deepEqual(
    body.map((item) => item.progress),
    [0, 75],
  );
});
