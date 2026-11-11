import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { paths, REPO_ROOT } from "../state.ts";
import type { Service } from "./service.ts";

const FIXTURE = "eden-fixture";
const INSTALLED = path.join(paths.aurralData, "plugins");

// The official plugins, pinned so every Eden runs the same code.
const OFFICIAL_REPO = "lklynet/aurral-plugins";
const OFFICIAL_COMMIT = "7b68882e07b5a414a70d3bef8832d91d635a6b28";

// Aurral under Eden can't reach GitHub, so Eden fetches the official plugins itself
// and puts their folders where Aurral looks for plugins.
async function installOfficialPlugins() {
  const folder = path.join(paths.outside, "official-plugins");
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const response = await fetch(
    `https://codeload.github.com/${OFFICIAL_REPO}/tar.gz/${OFFICIAL_COMMIT}`,
  );
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the official plugins`);
  const unpacked = spawnSync("tar", ["-xz", "--strip-components=1", "-C", folder], {
    input: Buffer.from(await response.arrayBuffer()),
  });
  if (unpacked.status !== 0) throw new Error(`tar failed: ${unpacked.stderr}`);
  const ids = readdirSync(folder).filter((id) =>
    existsSync(path.join(folder, id, "manifest.json")),
  );
  for (const id of ids)
    cpSync(path.join(folder, id), path.join(INSTALLED, id), { recursive: true });
  rmSync(folder, { recursive: true, force: true });
  return ids;
}

export const plugins: Service = {
  containers: [],
  about: () => `${FIXTURE} uses every capability; the official plugins are installed and off`,
  async setup({ api }) {
    mkdirSync(INSTALLED, { recursive: true });
    cpSync(path.join(REPO_ROOT, "eden", "plugins", FIXTURE), path.join(INSTALLED, FIXTURE), {
      recursive: true,
    });
    await installOfficialPlugins();
    await api.get("/plugins");
    // Searched after every real source, so it never takes a download a test meant for one.
    await api.put(`/plugins/${FIXTURE}`, {
      enabled: true,
      priority: 100,
      settings: { world: paths.world, greeting: "Hello" },
    });
  },
};
