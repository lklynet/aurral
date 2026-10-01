import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const resultsDir = process.env.AURRAL_LAB_RESULTS_DIR;
const playwright = JSON.parse(readFileSync("node_modules/@playwright/test/package.json", "utf8")).version;
writeFileSync(
  path.join(resultsDir, "runtime.json"),
  `${JSON.stringify({ node: process.version, playwright, browsers: readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH).filter((name) => !name.startsWith(".")) }, null, 2)}\n`,
);

const child = spawn("node_modules/.bin/playwright", ["test", ...process.argv.slice(2)], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
