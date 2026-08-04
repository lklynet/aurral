#!/usr/bin/env bash
set -euo pipefail

channel="${1:-}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
owner="${repository%%/*}"
repo="${repository#*/}"
max_field_chars=1000
max_description_chars=3500
max_list_items=12

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

truncate_text() {
  local text="$1"
  local limit="$2"
  if [ "${#text}" -le "${limit}" ]; then
    printf '%s' "${text}"
    return 0
  fi
  printf '%s…' "${text:0:$((limit - 1))}"
}

format_bullet_field() {
  local raw="$1"
  local empty_label="$2"
  local lines=()
  local line count=0 truncated=0

  if [ -z "${raw}" ]; then
    printf '%s' "${empty_label}"
    return 0
  fi

  while IFS= read -r line; do
    [ -z "${line}" ] && continue
    if [ "${count}" -ge "${max_list_items}" ]; then
      truncated=$((truncated + 1))
      continue
    fi
    lines+=("${line}")
    count=$((count + 1))
  done <<< "${raw}"

  if [ "${#lines[@]}" -eq 0 ]; then
    printf '%s' "${empty_label}"
    return 0
  fi

  local body
  body="$(printf '%s\n' "${lines[@]}")"
  if [ "${truncated}" -gt 0 ]; then
    body+=$'\n'"…and ${truncated} more"
  fi
  truncate_text "${body}" "${max_field_chars}"
}

collect_merged_pull_lines() {
  local head_sha="$1"
  local base_tag="$2"
  local commit_shas pull_number pull_line
  declare -A pull_numbers=()

  if [ -n "${base_tag}" ]; then
    commit_shas="$(gh api --paginate \
      "repos/${repository}/compare/${base_tag}...${head_sha}" \
      --jq '.commits[].sha')"
  else
    commit_shas="${head_sha}"
  fi

  while IFS= read -r commit_sha; do
    [ -z "${commit_sha}" ] && continue
    while IFS= read -r pull_number; do
      [ -z "${pull_number}" ] && continue
      pull_numbers["${pull_number}"]=1
    done <<< "$(gh api --paginate \
      "repos/${repository}/commits/${commit_sha}/pulls" \
      --jq '.[].number')"
  done <<< "${commit_shas}"

  local out=""
  for pull_number in $(printf '%s\n' "${!pull_numbers[@]}" | sort -n); do
    pull_line="$(gh api \
      "repos/${repository}/pulls/${pull_number}" \
      --jq '"- [#\(.number)](\(.html_url)) \(.title)"')"
    out+="${pull_line}"$'\n'
  done
  printf '%s' "${out%$'\n'}"
}

collect_closing_issue_lines_for_pulls() {
  local pull_lines="$1"
  local pull_number issue_number issue_line
  declare -A issue_numbers=()

  while IFS= read -r line; do
    [ -z "${line}" ] && continue
    if [[ "${line}" =~ \[\#([0-9]+)\] ]]; then
      pull_number="${BASH_REMATCH[1]}"
      while IFS= read -r issue_number; do
        [ -z "${issue_number}" ] && continue
        issue_numbers["${issue_number}"]=1
      done <<< "$(gh api graphql \
        -f query='query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              closingIssuesReferences(first: 100) {
                nodes { number }
              }
            }
          }
        }' \
        -f "owner=${owner}" \
        -f "repo=${repo}" \
        -F "number=${pull_number}" \
        --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[]?.number')"
    fi
  done <<< "${pull_lines}"

  local out=""
  for issue_number in $(printf '%s\n' "${!issue_numbers[@]}" | sort -n); do
    issue_line="$(gh api \
      "repos/${repository}/issues/${issue_number}" \
      --jq '"- [#\(.number)](\(.html_url)) \(.title)"')"
    out+="${issue_line}"$'\n'
  done
  printf '%s' "${out%$'\n'}"
}

previous_stable_tag() {
  local release_tag="${1:-}"
  local stable_tags
  stable_tags="$(gh api --paginate \
    "repos/${repository}/git/matching-refs/tags/v" \
    --jq '.[].ref | sub("^refs/tags/"; "")')"
  if [ -n "${release_tag}" ]; then
    printf '%s\n' "${stable_tags}" | awk 'NF' | sort -V | awk -v target="${release_tag}" '
      $0 == target { print previous; found=1; exit }
      { previous=$0 }
      END { if (!found) print previous }
    '
  else
    printf '%s\n' "${stable_tags}" | awk 'NF' | sort -V | tail -n1
  fi
}

pr_summary_excerpt() {
  local pr_number="$1"
  local body
  body="$(gh api "repos/${repository}/pulls/${pr_number}" --jq '.body // ""')"
  body="$(printf '%s\n' "${body}" | sed -e 's/\r$//' -e '/^<!--/,/-->$/d')"
  if printf '%s\n' "${body}" | grep -q '^## Summary'; then
    body="$(printf '%s\n' "${body}" | awk '
      BEGIN { take=0 }
      /^## Summary/ { take=1; next }
      /^## / { if (take) exit }
      take { print }
    ')"
  fi
  body="$(printf '%s\n' "${body}" | sed '/./,$!d' | head -n 8)"
  body="$(printf '%s\n' "${body}" | sed 's/[[:space:]]*$//')"
  if [ -z "${body}" ]; then
    printf '%s' "No summary provided on the pull request."
    return 0
  fi
  truncate_text "${body}" 500
}

embed_fields_json='[]'
description=""
title=""
url=""

add_field() {
  local name="$1"
  local value="$2"
  [ -z "${value}" ] && return 0
  embed_fields_json="$(
    EMBED_FIELDS_JSON="${embed_fields_json}" \
    FIELD_NAME="${name}" \
    FIELD_VALUE="${value}" \
    python3 -c 'import json, os; fields=json.loads(os.environ["EMBED_FIELDS_JSON"]); fields.append({"name": os.environ["FIELD_NAME"], "value": os.environ["FIELD_VALUE"], "inline": False}); print(json.dumps(fields))'
  )"
}

case "${channel}" in
  releases)
    release_version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
    release_tag="${RELEASE_TAG:?RELEASE_TAG is required}"
    head_sha="${HEAD_SHA:-${GITHUB_SHA:-}}"
    title="Aurral ${release_version} released"
    url="https://github.com/${repository}/releases/tag/${release_tag}"
    description="$(cat <<EOF
Stable \`${release_version}\` is published.

\`\`\`
docker pull ghcr.io/${repository}:${release_version}
docker pull ghcr.io/${repository}:latest
\`\`\`
EOF
)"
    release_notes="$(gh release view "${release_tag}" --repo "${repository}" --json body --jq '.body // ""' 2>/dev/null || true)"
    if [ -n "${release_notes}" ]; then
      release_notes="$(printf '%s\n' "${release_notes}" | sed -e 's/\r$//' -e '/^<!--/,/-->$/d' | head -n 20)"
      release_notes="$(truncate_text "$(printf '%s\n' "${release_notes}" | sed '/./,$!d')" 900)"
      if [ -n "${release_notes}" ]; then
        add_field "Release notes" "${release_notes}"
      fi
    fi
    if [ -n "${head_sha}" ]; then
      base_tag="$(previous_stable_tag "${release_tag}")"
      pull_list="$(collect_merged_pull_lines "${head_sha}" "${base_tag}")"
      issue_list="$(collect_closing_issue_lines_for_pulls "${pull_list}")"
      add_field "Included pull requests" "$(format_bullet_field "${pull_list}" "None recorded for this release.")"
      add_field "Linked issues" "$(format_bullet_field "${issue_list}" "None")"
    fi
    ;;
  nightly)
    nightly_version="${NIGHTLY_VERSION:?NIGHTLY_VERSION is required}"
    head_sha="${HEAD_SHA:-${GITHUB_SHA:?GITHUB_SHA is required}}"
    run_id="${GITHUB_RUN_ID:-}"
    change_url="${CHANGE_URL:-}"
    change_range="${CHANGE_RANGE:-}"
    readiness_issue="${READINESS_ISSUE:-}"
    pull_list="${PULL_LIST:-}"
    issue_list="${ISSUE_LIST:-}"
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
      description+=$'\n'"Changes since last stable: [\`${change_range}\`](${change_url})"
    fi
    if [ -n "${readiness_issue}" ]; then
      description+=$'\n'"Release readiness: https://github.com/${repository}/issues/${readiness_issue}"
    fi
    description+=$'\n'"Give feedback in #testing."
    if [ -z "${pull_list}" ] && [ -n "${head_sha}" ]; then
      base_tag="$(previous_stable_tag)"
      pull_list="$(collect_merged_pull_lines "${head_sha}" "${base_tag}")"
      issue_list="$(collect_closing_issue_lines_for_pulls "${pull_list}")"
    fi
    add_field "Included since last stable" "$(format_bullet_field "${pull_list}" "No merged pull requests in this range.")"
    add_field "Linked issues" "$(format_bullet_field "${issue_list}" "None")"
    ;;
  previews)
    pr_number="${PR_NUMBER:?PR_NUMBER is required}"
    pr_title="${PR_TITLE:?PR_TITLE is required}"
    image_tag="${IMAGE_TAG:?IMAGE_TAG is required}"
    title="Preview ready: #${pr_number}"
    url="https://github.com/${repository}/pull/${pr_number}"
    description="$(cat <<EOF
**${pr_title}**

First preview image for this pull request.

\`\`\`
docker pull ghcr.io/${repository}:${image_tag}
\`\`\`

How to test: see #testing.
EOF
)"
    add_field "What changed" "$(pr_summary_excerpt "${pr_number}")"
    closing_issues=""
    while IFS= read -r issue_number; do
      [ -z "${issue_number}" ] && continue
      issue_line="$(gh api \
        "repos/${repository}/issues/${issue_number}" \
        --jq '"- [#\(.number)](\(.html_url)) \(.title)"')"
      closing_issues+="${issue_line}"$'\n'
    done <<< "$(gh api graphql \
      -f query='query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            closingIssuesReferences(first: 100) {
              nodes { number }
            }
          }
        }
      }' \
      -f "owner=${owner}" \
      -f "repo=${repo}" \
      -F "number=${pr_number}" \
      --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[]?.number')"
    add_field "Linked issues" "$(format_bullet_field "${closing_issues%$'\n'}" "None linked yet")"
    ;;
esac

description="$(truncate_text "${description}" "${max_description_chars}")"

payload="$(
  DISCORD_EMBED_TITLE="${title}" \
  DISCORD_EMBED_DESCRIPTION="${description}" \
  DISCORD_EMBED_URL="${url}" \
  DISCORD_EMBED_FIELDS="${embed_fields_json}" \
  python3 -c 'import json, os; print(json.dumps({"embeds":[{"title": os.environ["DISCORD_EMBED_TITLE"], "description": os.environ["DISCORD_EMBED_DESCRIPTION"], "url": os.environ["DISCORD_EMBED_URL"], "fields": json.loads(os.environ["DISCORD_EMBED_FIELDS"])}]}))'
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
