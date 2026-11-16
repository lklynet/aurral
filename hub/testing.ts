import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getMigrations } from "better-auth/db/migration";
import { getPlatformProxy } from "wrangler";
import { authOptions } from "./src/auth.ts";
import type { Bindings } from "./src/index.ts";

const hubDir = import.meta.dirname;
const wrangler = path.join(hubDir, "node_modules", "wrangler", "bin", "wrangler.js");

export async function localHub({ migrate = true } = {}) {
  const persistTo = mkdtempSync(path.join(tmpdir(), "aurral-hub-"));
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };
  if (migrate) {
    execFileSync(
      process.execPath,
      [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistTo],
      {
        cwd: hubDir,
        env,
        stdio: "pipe",
      },
    );
  }
  const proxy = await getPlatformProxy<Bindings>({
    configPath: path.join(hubDir, "wrangler.jsonc"),
    persist: { path: path.join(persistTo, "v3") },
  });
  return {
    env: proxy.env,
    async dispose() {
      await proxy.dispose();
      rmSync(persistTo, { recursive: true, force: true });
    },
  };
}

export async function missingAuthSchema(env: Bindings) {
  const { toBeCreated, toBeAdded } = await getMigrations(authOptions(env));
  return [...toBeCreated, ...toBeAdded].map(({ table }) => table);
}
