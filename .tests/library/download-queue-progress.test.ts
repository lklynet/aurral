import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import { api } from "../../backend/routes/api.ts";
import { invalidateAllDownloadStatusesCache } from "../../backend/routes/library/handlers/downloads.ts";
import { lidarrClient } from "../../backend/services/lidarrClient.ts";
import { signedInAs } from "../helpers/honoApp.ts";

const app = signedInAs(undefined).route("/", api);

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

  const response = await app.request("/library/downloads");
  const items: { progress: number }[] = await response.json();
  assert.deepEqual(
    items.map((item) => item.progress),
    [0, 75],
  );
});
