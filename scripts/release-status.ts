import { execFileSync } from "node:child_process";
import { env, graphql } from "./github.ts";

type Channel = "nightly" | "stable";
type StatusLabel = "nightly" | "released";

export interface StatusItem {
  id: string;
  number: number;
  kind: "pull" | "issue";
  labels: string[];
}

interface Labels {
  labels: { nodes: { name: string }[] };
}

interface ChangesPage {
  repository: {
    nightly: { id: string } | null;
    released: { id: string } | null;
    ref: {
      compare: {
        commits: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            associatedPullRequests: {
              nodes: (Labels & {
                id: string;
                number: number;
                closingIssuesReferences: { nodes: (Labels & { id: string; number: number })[] };
              })[];
            };
          }[];
        };
      };
    } | null;
  };
}

const CHANGES_QUERY = `query($owner: String!, $repo: String!, $base: String!, $head: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    nightly: label(name: "nightly") { id }
    released: label(name: "released") { id }
    ref(qualifiedName: $base) {
      compare(headRef: $head) {
        commits(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            associatedPullRequests(first: 1) {
              nodes {
                id
                number
                labels(first: 50) { nodes { name } }
                closingIssuesReferences(first: 25) {
                  nodes { id number labels(first: 50) { nodes { name } } }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const MUTATIONS_PER_REQUEST = 30;

const labelNames = (node: Labels) => node.labels.nodes.map((label) => label.name);

export function planStatus(items: StatusItem[], channel: Channel) {
  const target: StatusLabel = channel === "stable" ? "released" : "nightly";
  const other: StatusLabel = channel === "stable" ? "nightly" : "released";
  return items
    .filter((item) => channel === "stable" || item.kind === "issue")
    .filter((item) => !item.labels.includes(target) || item.labels.includes(other))
    .map((item) => ({
      id: item.id,
      number: item.number,
      add: target,
      remove: item.labels.includes(other) ? other : null,
      comment: item.kind === "issue",
    }));
}

async function listChanges(repository: string, base: string, head: string) {
  const [owner, repo] = repository.split("/");
  const items = new Map<string, StatusItem>();
  let labelIds: Record<StatusLabel, string> | null = null;
  let cursor: string | null = null;
  do {
    const page: ChangesPage = await graphql(CHANGES_QUERY, {
      owner,
      repo,
      base: `refs/tags/${base}`,
      head,
      cursor,
    });
    const { nightly, released, ref } = page.repository;
    if (!nightly || !released) throw new Error("The nightly and released labels must exist");
    if (!ref) throw new Error(`Tag ${base} was not found`);
    labelIds = { nightly: nightly.id, released: released.id };
    for (const commit of ref.compare.commits.nodes) {
      for (const pull of commit.associatedPullRequests.nodes) {
        items.set(pull.id, {
          id: pull.id,
          number: pull.number,
          kind: "pull",
          labels: labelNames(pull),
        });
        for (const issue of pull.closingIssuesReferences.nodes) {
          items.set(issue.id, {
            id: issue.id,
            number: issue.number,
            kind: "issue",
            labels: labelNames(issue),
          });
        }
      }
    }
    const { pageInfo } = ref.compare.commits;
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
  if (!labelIds) throw new Error("No changes page was read");
  return { items: [...items.values()], labelIds };
}

function commentBody(channel: Channel, repository: string) {
  if (channel === "nightly") {
    return `The change for this issue is now on nightly (\`${env("NIGHTLY_VERSION")}\`).

\`\`\`bash
docker pull ghcr.io/${repository}:nightly
\`\`\``;
  }
  const version = env("RELEASE_VERSION");
  return `The change for this issue is included in [Aurral ${version}](https://github.com/${repository}/releases/tag/v${version}).

\`\`\`bash
docker pull ghcr.io/${repository}:${version}
\`\`\``;
}

export function statusMutations(
  plan: ReturnType<typeof planStatus>,
  labelIds: Record<StatusLabel, string>,
) {
  const fields = plan.flatMap((step, index) => {
    const id = JSON.stringify(step.id);
    const labels = (label: StatusLabel) =>
      `{labelableId: ${id}, labelIds: [${JSON.stringify(labelIds[label])}]}`;
    return [
      `a${index}: addLabelsToLabelable(input: ${labels(step.add)}) { clientMutationId }`,
      ...(step.remove
        ? [
            `r${index}: removeLabelsFromLabelable(input: ${labels(step.remove)}) { clientMutationId }`,
          ]
        : []),
      ...(step.comment
        ? [`c${index}: addComment(input: {subjectId: ${id}, body: $body}) { clientMutationId }`]
        : []),
    ];
  });
  return Array.from({ length: Math.ceil(fields.length / MUTATIONS_PER_REQUEST) }, (_, index) => {
    const chunk = fields.slice(index * MUTATIONS_PER_REQUEST, (index + 1) * MUTATIONS_PER_REQUEST);
    const usesBody = chunk.some((field) => field.includes("$body"));
    return `mutation${usesBody ? "($body: String!)" : ""} {\n${chunk.join("\n")}\n}`;
  });
}

if (import.meta.main) {
  const channel = process.argv[2];
  if (channel !== "nightly" && channel !== "stable") {
    throw new Error("Usage: node scripts/release-status.ts nightly|stable");
  }
  const repository = env("GITHUB_REPOSITORY");
  const head = env("GITHUB_SHA");
  const base = execFileSync(
    "git",
    [
      "describe",
      "--tags",
      "--abbrev=0",
      "--match",
      "v[0-9]*",
      channel === "stable" ? `${head}^` : head,
    ],
    { encoding: "utf8" },
  ).trim();

  const { items, labelIds } = await listChanges(repository, base, head);
  const plan = planStatus(items, channel);
  const body = commentBody(channel, repository);
  for (const mutation of statusMutations(plan, labelIds)) {
    await graphql(mutation, mutation.includes("$body") ? { body } : {});
  }
  console.log(
    `${base}...${head.slice(0, 7)}: ${items.length} pull requests and issues, updated ${plan.map((step) => `#${step.number}`).join(" ") || "none"}.`,
  );
}
