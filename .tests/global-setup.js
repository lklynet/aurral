import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const runDir = mkdtempSync(join(tmpdir(), "aurral-test-run-"));
  process.env.TMPDIR = runDir;
  process.once("exit", () => rmSync(runDir, { recursive: true, force: true }));
}
