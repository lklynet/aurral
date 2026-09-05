import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveAppVersion } from "../../lib/app-version.js";

function makeTempGitRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), "aurral-version-test-"));
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Aurral Tests"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "tag.gpgsign", "false"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tests@example.com"], {
    cwd: repoDir,
    stdio: "ignore",
  });
  writeFileSync(join(repoDir, "README.md"), "test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  return repoDir;
}

test("resolveAppVersion prefers explicit environment values", () => {
  assert.equal(resolveAppVersion({ envValue: "v1.76.1" }), "1.76.1");
});

test("resolveAppVersion uses exact release tag at HEAD when present", () => {
  const repoDir = makeTempGitRepo();
  execFileSync("git", ["tag", "v1.76.1"], { cwd: repoDir, stdio: "ignore" });

  assert.equal(resolveAppVersion({ cwd: repoDir }), "1.76.1");
});

test("resolveAppVersion falls back to short git sha when no release tag exists", () => {
  const repoDir = makeTempGitRepo();
  const shortSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

  assert.equal(resolveAppVersion({ cwd: repoDir }), shortSha);
});

test("resolveAppVersion returns unknown when no env or git data is available", () => {
  assert.equal(resolveAppVersion({ cwd: "/definitely/not/a/repo" }), "unknown");
});
