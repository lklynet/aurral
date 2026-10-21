import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const baselinePath = new URL("../typecheck-baseline.json", import.meta.url);
const update = process.argv.includes("--update");

const tsc = new URL(
  "bin/tsc",
  pathToFileURL(createRequire(import.meta.url).resolve("typescript/package.json")),
);
const result = spawnSync(process.execPath, [fileURLToPath(tsc), "-p", ".", "--pretty", "false"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  maxBuffer: 1 << 28,
});
const output = `${result.stdout}${result.stderr}`;
const errorLines = output.split("\n").filter((line) => /: error TS\d+:/.test(line));

const finishedWithErrors = result.status === 1 && errorLines.length > 0;
const finishedClean = result.status === 0 && errorLines.length === 0;
if (result.error || result.signal || !(finishedClean || finishedWithErrors)) {
  process.stderr.write(output);
  console.error(
    `tsc did not finish: ${result.error?.message ?? result.signal ?? `exit ${result.status}`}`,
  );
  process.exit(1);
}

const counts: Record<string, number> = {};
for (const line of errorLines) {
  const file = line.slice(0, line.indexOf("("));
  counts[file] = (counts[file] ?? 0) + 1;
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Wrote ${errorLines.length} type errors across ${Object.keys(sorted).length} files.`);
  process.exit(0);
}

const baseline: Record<string, number> = JSON.parse(readFileSync(baselinePath, "utf8"));
const worse = Object.entries(sorted).filter(([file, count]) => count > (baseline[file] ?? 0));
const better = Object.entries(baseline).filter(([file, count]) => (sorted[file] ?? 0) < count);

if (worse.length > 0) {
  for (const [file, count] of worse) {
    console.error(`${file}: ${count} type errors, baseline allows ${baseline[file] ?? 0}`);
    for (const line of errorLines.filter((l) => l.startsWith(`${file}(`)))
      console.error(`  ${line}`);
  }
  console.error("\nFix the new type errors. Never raise the baseline to make this pass.");
  process.exit(1);
}

const total = errorLines.length;
const allowed = Object.values(baseline).reduce((sum, count) => sum + count, 0);
console.log(`${total} type errors, baseline allows ${allowed}.`);
if (better.length > 0) {
  console.log(
    `${better.length} files improved. Run \`npm run typecheck -- --update\` to lock it in.`,
  );
}
