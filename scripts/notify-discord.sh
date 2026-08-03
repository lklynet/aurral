#!/usr/bin/env bash
set -euo pipefail

channel="${1:-}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

case "${channel}" in
  releases)
    webhook_url="${DISCORD_WEBHOOK_RELEASES:-}"
    ;;
  nightly)
    webhook_url="${DISCORD_WEBHOOK_NIGHTLY:-}"
    ;;
  previews)
    webhook_url="${DISCORD_WEBHOOK_PREVIEWS:-}"
    ;;
  *)
    echo "Usage: $0 releases|nightly|previews" >&2
    exit 2
    ;;
esac

if [ -z "${webhook_url}" ]; then
  echo "Discord webhook for ${channel} is not configured; skipping."
  exit 0
fi

case "${channel}" in
  releases)
    release_version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
    release_tag="${RELEASE_TAG:?RELEASE_TAG is required}"
    title="Aurral ${release_version} released"
    url="https://github.com/${repository}/releases/tag/${release_tag}"
    description="$(cat <<EOF
Stable release \`${release_version}\` is published.

\`\`\`
docker pull ghcr.io/${repository}:${release_version}
docker pull ghcr.io/${repository}:latest
\`\`\`

${url}
EOF
)"
    ;;
  nightly)
    nightly_version="${NIGHTLY_VERSION:?NIGHTLY_VERSION is required}"
    head_sha="${HEAD_SHA:-${GITHUB_SHA:?GITHUB_SHA is required}}"
    run_id="${GITHUB_RUN_ID:-}"
    change_url="${CHANGE_URL:-}"
    change_range="${CHANGE_RANGE:-}"
    readiness_issue="${READINESS_ISSUE:-}"
    title="Nightly ${nightly_version}"
    url="https://github.com/${repository}/actions/runs/${run_id}"
    description="$(cat <<EOF
\`ghcr.io/${repository}:nightly\` was rebuilt from \`${head_sha:0:7}\`.

\`\`\`
docker pull ghcr.io/${repository}:nightly
\`\`\`
EOF
)"
    if [ -n "${change_range}" ] && [ -n "${change_url}" ]; then
      description+=$'\n'"Changes: [\`${change_range}\`](${change_url})"
    fi
    if [ -n "${readiness_issue}" ]; then
      description+=$'\n'"Release readiness: https://github.com/${repository}/issues/${readiness_issue}"
    fi
    description+=$'\n'"Give feedback in #testing."
    ;;
  previews)
    pr_number="${PR_NUMBER:?PR_NUMBER is required}"
    pr_title="${PR_TITLE:?PR_TITLE is required}"
    image_tag="${IMAGE_TAG:?IMAGE_TAG is required}"
    title="Preview ready: #${pr_number}"
    url="https://github.com/${repository}/pull/${pr_number}"
    description="$(cat <<EOF
**${pr_title}**

First preview image for this pull request is ready.

\`\`\`
docker pull ghcr.io/${repository}:${image_tag}
\`\`\`

How to test: see #testing.
${url}
EOF
)"
    ;;
esac

payload="$(
  DISCORD_EMBED_TITLE="${title}" \
  DISCORD_EMBED_DESCRIPTION="${description}" \
  DISCORD_EMBED_URL="${url}" \
  python3 -c 'import json, os; print(json.dumps({"embeds":[{"title": os.environ["DISCORD_EMBED_TITLE"], "description": os.environ["DISCORD_EMBED_DESCRIPTION"], "url": os.environ["DISCORD_EMBED_URL"]}]}))'
)"

http_code="$(curl -sS -o /tmp/aurral-discord-response.txt -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "${payload}" \
  "${webhook_url}")"

if [ "${http_code}" -lt 200 ] || [ "${http_code}" -ge 300 ]; then
  echo "Discord webhook for ${channel} returned HTTP ${http_code}:" >&2
  cat /tmp/aurral-discord-response.txt >&2 || true
  exit 1
fi

echo "Posted Discord notification to ${channel}."
