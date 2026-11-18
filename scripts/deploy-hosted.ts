import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostedBuildPath } from "../lib/hostedBuild.ts";
import { isRecord } from "../lib/isRecord.ts";
import { env } from "./github.ts";

const BUCKET = "aurral-music";
const CHANNELS = ["stable", "nightly"];
const FILE_LIMIT = 19_000;
const HEADERS = `/*
  Content-Security-Policy: script-src 'self'; frame-ancestors 'none'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;

const version = env("HOSTED_VERSION");
const channel = env("HOSTED_CHANNEL");
if (!CHANNELS.includes(channel)) throw new Error(`HOSTED_CHANNEL must be one of ${CHANNELS}`);
const account = env("CLOUDFLARE_ACCOUNT_ID");
const token = env("CLOUDFLARE_API_TOKEN");

const hosted = path.resolve("hosted");
const site = path.join(hosted, "site");
const work = await mkdtemp(path.join(tmpdir(), "aurral-hosted-"));
const wrangler = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: hosted, stdio: "inherit" });

const listBuilds = async () => {
  const builds: { key: string; uploaded: string }[] = [];
  let cursor = "";
  do {
    const query = new URLSearchParams({ per_page: "1000", ...(cursor && { cursor }) });
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects?${query}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body: unknown = await response.json();
    if (!response.ok || !isRecord(body) || !Array.isArray(body.result)) {
      throw new Error(`Listing ${BUCKET} returned ${response.status}`);
    }
    for (const object of body.result) {
      if (isRecord(object) && typeof object.key === "string" && object.key.endsWith(".tgz")) {
        builds.push({ key: object.key, uploaded: String(object.last_modified) });
      }
    }
    const info = isRecord(body.result_info) ? body.result_info : {};
    cursor = info.is_truncated === true && typeof info.cursor === "string" ? info.cursor : "";
  } while (cursor);
  return builds.sort(
    (a, b) =>
      Number(a.key.startsWith("nightly/")) - Number(b.key.startsWith("nightly/")) ||
      b.uploaded.localeCompare(a.uploaded),
  );
};

const archive = path.join(work, "build.tgz");
execFileSync("tar", [
  "-czf",
  archive,
  "-C",
  "frontend/dist-hosted",
  "assets",
  hostedBuildPath(version).slice(1),
]);
wrangler(
  "r2",
  "object",
  "put",
  `${BUCKET}/${channel}/${version}.tgz`,
  "--file",
  archive,
  "--remote",
);

await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
const files = new Set<string>();
const included: string[] = [];
for (const { key } of await listBuilds()) {
  const download = path.join(work, "download.tgz");
  wrangler("r2", "object", "get", `${BUCKET}/${key}`, "--file", download, "--remote");
  const build = await mkdtemp(path.join(work, "build-"));
  execFileSync("tar", ["-xzf", download, "-C", build]);
  const added = (await readdir(build, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(build, path.join(entry.parentPath, entry.name)))
    .filter((file) => !files.has(file));
  if (files.size + added.length > FILE_LIMIT) break;
  for (const file of added) files.add(file);
  await cp(build, site, { recursive: true });
  included.push(key.slice(key.indexOf("/") + 1, -".tgz".length));
}

const [root] = included;
if (!root) throw new Error("No build fits on the site");
await copyFile(path.join(site, hostedBuildPath(root), "index.html"), path.join(site, "index.html"));
await writeFile(path.join(site, "_headers"), HEADERS);
console.log(`Deploying ${included.length} builds in ${files.size} files. / runs ${root}.`);
wrangler("deploy");
