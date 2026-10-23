import fs from "node:fs";

const operation: "existsSync" | "watch" = process.argv[2] === "/slow-path-mapping" ? "existsSync" : "watch";
if (operation === "watch") Object.assign(fs, { statSync: () => {} });
Object.assign(fs, { [operation]: () => {
  process.send?.({ type: "blocked-operation", operation });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  throw new Error("The parent should terminate this blocked watcher first");
} });

await import("../../backend/services/libraryWatchProcessChild.ts");
