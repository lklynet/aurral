import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.AURRAL_DATA_DIR && !process.env.AURRAL_DB_PATH) {
  const dataDir = mkdtempSync(join(tmpdir(), `aurral-test-${process.pid}-`));
  process.env.AURRAL_DATA_DIR = dataDir;
  process.env.AURRAL_DB_PATH = join(dataDir, "aurral.db");
  process.on("exit", () => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });
}
