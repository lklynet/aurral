import { readFile } from "node:fs/promises";
import { env } from "./github.ts";

const DESCRIPTION_LIMIT = 3500;

const webhook = process.env.DISCORD_WEBHOOK_ANNOUNCEMENTS;
if (webhook) {
  const repository = env("GITHUB_REPOSITORY");
  const version = env("RELEASE_VERSION");
  const url = `https://github.com/${repository}/releases/tag/v${version}`;
  const notes = await readFile(`release-notes/${version}.md`, "utf8").catch(() => "");
  const description = `**Install with Docker**

\`docker pull ghcr.io/${repository}:${version}\`
\`docker pull ghcr.io/${repository}:latest\`

${notes.trim() || `[Read the release notes on GitHub](${url}).`}`;

  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: `Aurral ${version} is out!`,
          url,
          description:
            description.length > DESCRIPTION_LIMIT
              ? `${description.slice(0, DESCRIPTION_LIMIT - 1)}…`
              : description,
        },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`Discord returned ${response.status}: ${await response.text()}`);
  console.log(`Announced Aurral ${version} on Discord.`);
} else {
  console.log("DISCORD_WEBHOOK_ANNOUNCEMENTS is not set; skipping the announcement.");
}
