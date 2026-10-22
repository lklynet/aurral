import { mkdtempSync } from "node:fs";
import "./offline-guard.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const offlineGuard = new URL("./offline-guard.ts", import.meta.url).href;
if (!process.env.NODE_OPTIONS?.includes(offlineGuard)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --import=${offlineGuard}`.trim();
}

if (!process.env.AURRAL_DATA_DIR && !process.env.AURRAL_DB_PATH) {
  const dataDir = mkdtempSync(join(tmpdir(), `aurral-test-${process.pid}-`));
  process.env.AURRAL_DATA_DIR = dataDir;
  process.env.AURRAL_DB_PATH = join(dataDir, "aurral.db");
}
