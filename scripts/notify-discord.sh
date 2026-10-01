#!/usr/bin/env bash
set -euo pipefail

channel="${1:-}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
max_description_chars=3500

case "${channel}" in
  releases)
    webhook_url="${DISCORD_WEBHOOK_ANNOUNCEMENTS:-}"
    ;;
  *)
    echo "Usage: $0 releases" >&2
    exit 2
    ;;
esac

if [ -z "${webhook_url}" ]; then
  echo "Discord webhook for ${channel} is not configured; skipping."
  exit 0
fi

truncate_text() {
  local text="$1"
  local limit="$2"
  if [ "${#text}" -le "${limit}" ]; then
    printf '%s' "${text}"
    return 0
  fi
  printf '%s…' "${text:0:$((limit - 1))}"
}

release_version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
release_tag="${RELEASE_TAG:?RELEASE_TAG is required}"
title="Aurral ${release_version} is out!"
url="https://github.com/${repository}/releases/tag/${release_tag}"
description="$(cat <<EOF
**Install with Docker**

\`docker pull ghcr.io/${repository}:${release_version}\`
\`docker pull ghcr.io/${repository}:latest\`
EOF
)"
release_notes_file="release-notes/${release_version}.md"
if [ -s "${release_notes_file}" ]; then
  description+=$'\n\n'"$(cat "${release_notes_file}")"
else
  description+=$'\n\n'"[Read the release notes on GitHub](https://github.com/${repository}/releases/tag/${release_tag})."
fi

description="$(truncate_text "${description}" "${max_description_chars}")"

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
