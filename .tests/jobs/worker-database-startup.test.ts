import { test, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [state] = await setupIsolatedBackend(
  "worker-database-startup",
  () => import("../../backend/config/db-sqlite.ts"),
);

afterAll(() => cleanupIsolatedState(state));

test("a background worker starts while another process holds a long write", async () => {
  const holder = new Database(state.dbPath);
  holder.exec("BEGIN IMMEDIATE");
  try {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { db } = await import(${JSON.stringify(new URL("../../backend/config/db-sqlite.ts", import.meta.url).href)});
         process.stdout.write(String(db.prepare("SELECT value FROM settings WHERE key = 'schemaVersion'").pluck().get()));`,
      ],
      {
        env: { ...process.env, AURRAL_BACKGROUND_WORKER_GROUP: "library" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, output);
    assert.match(output, /^\d+$/);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});
