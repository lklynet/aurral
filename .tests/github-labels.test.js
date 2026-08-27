import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "label-pr-from-title.sh");

function runLabelScript(title) {
  const tempDir = mkdtempSync(join(tmpdir(), "aurral-github-label-test-"));
  const binDir = join(tempDir, "bin");
  const logPath = join(tempDir, "gh.log");
  const ghPath = join(binDir, "gh");
  mkdirSync(binDir);
  writeFileSync(
    ghPath,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GH_LOG\"\n",
    "utf8",
  );
  chmodSync(ghPath, 0o755);

  execFileSync("bash", [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GH_LOG: logPath,
      GITHUB_REPOSITORY: "lklynet/aurral",
      PATH: `${binDir}:${process.env.PATH}`,
      PR_NUMBER: "1",
      PR_TITLE: title,
    },
    stdio: "ignore",
  });

  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

test("PR label automation preserves canonical label colors", () => {
  const expected = [
    ["fix: preserve labels", "bug", "d73a4a"],
    ["feat: improve labels", "enhancement", "a2eeef"],
    ["docs: explain labels", "documentation", "0075ca"],
  ];

  for (const [title, label, color] of expected) {
    const commands = runLabelScript(title);
    assert.ok(
      commands.includes(
        `label create ${label} --repo lklynet/aurral --color ${color} --force`,
      ),
      commands.join("\n"),
    );
  }
});
