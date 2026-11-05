import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import {
  compareReleaseVersions,
  parseNightlyVersion,
  releaseChannel,
} from "../../lib/release-version.ts";
import { APP_VERSION } from "../config/constants.ts";
import { dbOps } from "../db/helpers/index.ts";
import { logger } from "./logger.ts";
import { SHARE_ORIGIN } from "./shareLinks/store.ts";

const REPOSITORY = "lklynet/aurral";
const FEED_SETTING = "updates:feed";
const MAX_NIGHTLY_NOTES = 8;

const feedSchema = v.object({
  stable: v.nullable(
    v.object({ version: v.string(), url: v.string(), notes: v.array(v.string()) }),
  ),
  nightly: v.nullable(
    v.object({
      version: v.string(),
      sha: v.string(),
      commits: v.array(v.object({ sha: v.string(), subject: v.string() })),
    }),
  ),
});

type UpdateFeed = v.InferOutput<typeof feedSchema>;

export function selectAvailableUpdate(version: string, feed: UpdateFeed | null) {
  const nightly = parseNightlyVersion(version);
  if (nightly) {
    const latest = parseNightlyVersion(feed?.nightly?.version);
    if (!feed?.nightly || !latest || latest.run <= nightly.run) return null;
    const { commits } = feed.nightly;
    const installedAt = commits.findIndex((commit) => commit.sha.startsWith(nightly.sha));
    const newer = installedAt === -1 ? commits : commits.slice(0, installedAt);
    return {
      channel: "nightly" as const,
      current: nightly.sha,
      latest: latest.sha,
      url: `https://github.com/${REPOSITORY}/compare/${nightly.sha}...${latest.sha}`,
      notes: newer
        .slice(0, MAX_NIGHTLY_NOTES)
        .map((commit) => commit.subject)
        .reverse(),
    };
  }
  if (!feed?.stable || compareReleaseVersions(feed.stable.version, version) <= 0) return null;
  return {
    channel: "stable" as const,
    current: version,
    latest: feed.stable.version,
    url: feed.stable.url,
    notes: feed.stable.notes,
  };
}

export function getAvailableUpdate() {
  return selectAvailableUpdate(APP_VERSION, dbOps.getJSONSetting(FEED_SETTING, feedSchema));
}

export async function checkForUpdates() {
  if (!releaseChannel(APP_VERSION) || (process.env.GITHUB_REPO || REPOSITORY) !== REPOSITORY) {
    return;
  }
  try {
    const response = await fetch(
      `${SHARE_ORIGIN}/api/updates?version=${encodeURIComponent(APP_VERSION)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw new Error(`aurral.org answered ${response.status}`);
    dbOps.setJSONSetting(FEED_SETTING, v.parse(feedSchema, await response.json()));
  } catch (error) {
    logger.debug("system", "Could not check aurral.org for updates:", {
      message: asAppError(error)?.message,
    });
  }
}
