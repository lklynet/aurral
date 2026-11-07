import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RULES = [
  "no-unsafe-argument",
  "no-unsafe-assignment",
  "no-unsafe-call",
  "no-unsafe-member-access",
  "no-unsafe-return",
];

const baselinePath = new URL("../lint-any-baseline.json", import.meta.url);
const update = process.argv.includes("--update");

const result = spawnSync(
  fileURLToPath(new URL("../node_modules/.bin/vp", import.meta.url)),
  ["lint", "-A", "all", ...RULES.flatMap((rule) => ["-D", `typescript/${rule}`]), "-f", "unix"],
  { cwd: new URL("..", import.meta.url), encoding: "utf8", maxBuffer: 1 << 28 },
);
const output = `${result.stdout}${result.stderr}`;
const findings = output
  .split("\n")
  .filter((line) => /^[^:\s]+\.(ts|tsx|mts):\d+:\d+: .*\(no-unsafe-[a-z-]+\)\]$/.test(line));

if (result.error || result.signal || ![0, 1].includes(result.status ?? -1)) {
  process.stderr.write(output);
  console.error(`lint did not finish: ${result.error?.message ?? result.signal ?? result.status}`);
  process.exit(1);
}

const counts: Record<string, number> = {};
for (const line of findings) {
  const file = line.slice(0, line.indexOf(":"));
  counts[file] = (counts[file] ?? 0) + 1;
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(
    `Wrote ${findings.length} unsafe any uses across ${Object.keys(sorted).length} files.`,
  );
  process.exit(0);
}

const baseline: Record<string, number> = JSON.parse(readFileSync(baselinePath, "utf8"));
const worse = Object.entries(sorted).filter(([file, count]) => count > (baseline[file] ?? 0));
const better = Object.entries(baseline).filter(([file, count]) => (sorted[file] ?? 0) < count);

if (worse.length > 0) {
  for (const [file, count] of worse) {
    console.error(`${file}: ${count} unsafe any uses, baseline allows ${baseline[file] ?? 0}`);
    for (const line of findings.filter((finding) => finding.startsWith(`${file}:`)))
      console.error(`  ${line}`);
  }
  console.error("\nNarrow the new any values. Never raise the baseline to make this pass.");
  process.exit(1);
}

const allowed = Object.values(baseline).reduce((sum, count) => sum + count, 0);
console.log(`${findings.length} unsafe any uses, baseline allows ${allowed}.`);
if (better.length > 0) {
  console.log(`${better.length} files improved. Run \`pnpm run lint:any --update\` to lock it in.`);
}
