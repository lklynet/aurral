import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { createIsolatedStateDir, startServerProcess } from "./helpers/backendTestHarness.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const labEnv = parseEnv(readFileSync(join(repoRoot, "tests", "lab", "lab.env"), "utf8"));

test("the Lab seed creates an onboarded admin who signs in through Aurral", async (t) => {
  const paths = await createIsolatedStateDir("lab-seed");
  t.after(() => rm(paths.baseDir, { recursive: true, force: true }));

  await promisify(execFile)(process.execPath, [join(repoRoot, "tests", "lab", "seed.mjs")], {
    env: { PATH: process.env.PATH, AURRAL_DATA_DIR: paths.dataDir, ...labEnv },
  });

  const server = await startServerProcess({
    extraEnv: { AURRAL_DATA_DIR: paths.dataDir, AURRAL_DB_PATH: join(paths.dataDir, "aurral.db") },
  });
  t.after(() => server.stop());
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const login = (password) =>
    fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: labEnv.AUTH_USER, password }),
    });

  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.onboardingRequired, false);
  assert.equal(health.authRequired, true);

  const accepted = await login(labEnv.AUTH_PASSWORD);
  assert.equal(accepted.status, 200);
  const { token, user } = await accepted.json();
  assert.equal(user.role, "admin");
  assert.equal((await login(`${labEnv.AUTH_PASSWORD}-wrong`)).status, 401);

  const library = (kind) =>
    fetch(`${baseUrl}/api/library/canonical?kind=${kind}&pageSize=100`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.json());
  const artists = (await library("artists")).items;
  assert.equal(artists.length, 1);
  assert.equal(artists[0].mbid ?? null, null);
  assert.equal(artists[0].providerId ?? null, null);
  const tracks = (await library("tracks")).items;
  assert.equal(tracks.length, 2);
  assert.ok(tracks.every((track) => track.artistName === artists[0].name));
});
