import { mock } from "node:test";
mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
const { SlskdClient } = await import("../../backend/services/slskdClient.js");
const client = new SlskdClient({ enabled: true, url: process.env.SLSKD_TEST_URL });
process.on("message", (message) => {
  if (message === "advance") mock.timers.tick(30000);
});
try {
  await client.createSearch("First", { id: "backing-off-search", deadline: Date.now() + 90000, searchTimeoutMs: 90000 });
  process.send?.({ done: true });
} catch (error) {
  process.send?.({ error: error.message });
} finally {
  mock.timers.reset();
  const { closeHonkerDb } = await import("../../backend/services/honkerDb.js");
  closeHonkerDb();
  process.disconnect();
}
