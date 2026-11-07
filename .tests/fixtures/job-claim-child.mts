import { defineQueue } from "../../backend/services/jobs/queue.ts";

const queue = defineQueue<{ kind: string }>({
  name: "test-jobs",
  group: "maintenance",
  leaseMs: 60_000,
  maxAttempts: 3,
  retryDelayMs: 1000,
  timeoutMs: 60_000,
  skipInTest: true,
  start: async () => undefined,
});

process.on("message", (step) => {
  if (step === "enqueue") {
    process.send?.(queue.enqueue({ kind: "dedupe" }, { dedupeKey: "shared" }));
    return;
  }
  const claimed: number[] = [];
  for (let job = queue.claim(); job; job = queue.claim()) {
    claimed.push(job.id);
    job.ack();
  }
  process.send?.(claimed, () => process.exit(0));
});
process.send?.("ready");
