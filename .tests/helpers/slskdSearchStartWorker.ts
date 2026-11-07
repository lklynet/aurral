const { SlskdClient } = await import("../../backend/services/slskdClient.ts");
const client = new SlskdClient({ enabled: true, url: process.env.SLSKD_TEST_URL });
try {
  await client.createSearch("Worker search", { id: "worker-search" });
  process.send?.({ done: true });
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.message : String(error) });
} finally {
  process.disconnect?.();
}
export {};
