import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { env, github } from "./github.ts";

const pullRequestEvent = v.object({
  pull_request: v.object({
    number: v.number(),
    title: v.string(),
    additions: v.number(),
    deletions: v.number(),
    labels: v.array(v.object({ name: v.string() })),
  }),
});

const TYPE_LABELS = new Map([
  ["feat", "enhancement"],
  ["fix", "bug"],
  ["docs", "documentation"],
]);
const SIZE_LABELS = [
  { below: 10, label: "size:XS" },
  { below: 30, label: "size:S" },
  { below: 100, label: "size:M" },
  { below: 500, label: "size:L" },
  { below: 1000, label: "size:XL" },
  { below: Infinity, label: "size:XXL" },
];

const event = v.parse(
  pullRequestEvent,
  JSON.parse(await readFile(env("GITHUB_EVENT_PATH"), "utf8")),
);
const { number, title, additions, deletions } = event.pull_request;
const current = event.pull_request.labels.map((label) => label.name);

const type = /^(\w+)(?:\([^)]*\))?!?:\s/.exec(title)?.[1]?.toLowerCase();
const typeLabel = type ? TYPE_LABELS.get(type) : undefined;
const sizeLabel = SIZE_LABELS.find(({ below }) => additions + deletions < below)?.label;
const managed = [...SIZE_LABELS.map(({ label }) => label), ...(type ? TYPE_LABELS.values() : [])];
const wanted = [sizeLabel, typeLabel].filter((label) => label !== undefined);

const add = wanted.filter((label) => !current.includes(label));
const remove = current.filter((label) => managed.includes(label) && !wanted.includes(label));

const path = `/repos/${env("GITHUB_REPOSITORY")}/issues/${number}/labels`;
if (add.length) await github(path, { method: "POST", body: JSON.stringify({ labels: add }) });
for (const label of remove) {
  await github(`${path}/${encodeURIComponent(label)}`, { method: "DELETE" });
}
console.log(
  `#${number}: added ${add.join(", ") || "nothing"}, removed ${remove.join(", ") || "nothing"}.`,
);
