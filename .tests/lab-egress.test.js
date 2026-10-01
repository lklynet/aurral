import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createMockHttpServer } from "./helpers/backendTestHarness.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const preload = pathToFileURL(join(repoRoot, "tests", "lab", "egress.mjs")).href;

async function fetchInLab(url, env = {}) {
  const script = `fetch(${JSON.stringify(url)}).then(async (r) => console.log("status", r.status, await r.text()), (e) => console.log("error", e.cause?.message || e.message))`;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", preload, "-e", script], {
    env: { PATH: process.env.PATH, ...env },
  });
  return { stdout: stdout.trim(), stderr };
}

test("the Lab preload blocks outside hosts and reaches fixtures through their mapped ports", async (t) => {
  const fixture = await createMockHttpServer((_request, response) => response.end("from fixture"));
  t.after(() => fixture.close());
  const { port } = new URL(fixture.url);

  const blocked = await fetchInLab("http://api.outside.test/resource");
  assert.match(blocked.stdout, /^error Aurral Lab blocked an outbound connection to api\.outside\.test/);
  assert.match(blocked.stderr, /\[lab-egress\] blocked outbound connection to api\.outside\.test/);

  const redirected = await fetchInLab("http://fixtures:8601/artist/1", {
    AURRAL_LAB_REDIRECTS: JSON.stringify({ "fixtures:8601": `127.0.0.1:${port}` }),
  });
  assert.equal(redirected.stdout, "status 200 from fixture");
});
