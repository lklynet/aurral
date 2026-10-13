import v8 from "node:v8";

process.send({ type: "ready" });

process.on("message", (message) => {
  if (message?.type === "report-heap-limit") {
    process.send({ type: "heap-limit", bytes: v8.getHeapStatistics().heap_size_limit });
  } else if (message?.type === "run-job") {
    const { rss, heapUsed } = process.memoryUsage();
    process.send({ type: "job-started", queue: message.queue, jobId: message.jobId, payload: message.payload });
    process.send({ type: "heartbeat", workers: [], memory: { rss, heapUsed } }, () => {
      if (v8.getHeapStatistics().heap_size_limit >= message.defaultHeapLimit) process.exit(1);
      const kept = [];
      for (;;) kept.push(new Array(10000).fill(Math.random()));
    });
  } else if (message?.type === "shutdown") {
    process.exit(0);
  }
});
