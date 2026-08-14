#!/usr/bin/env bash
set -euo pipefail

channel="${1:-}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
owner="${repository%%/*}"
repo="${repository#*/}"
max_field_chars=1000
max_description_chars=3500
max_embed_chars=6000
max_embed_fields=25

case "${channel}" in
  releases|nightly)
    webhook_url="${DISCORD_WEBHOOK_ANNOUNCEMENTS:-}"
    ;;
  *)
    echo "Usage: $0 releases|nightly" >&2
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

add_bullet_fields() {
  local raw="$1"
  local empty_label="$2"
  local name="$3"
  local line candidate chunk="" part=0 field_name

  if [ -z "${raw}" ]; then
    add_field "${name}" "${empty_label}"
    return 0
  fi

  while IFS= read -r line; do
    [ -z "${line}" ] && continue
    if [ -n "${chunk}" ]; then
      candidate="${chunk}"$'\n'"${line}"
    else
      candidate="${line}"
    fi

    if [ "${#candidate}" -gt "${max_field_chars}" ]; then
      if [ -z "${chunk}" ]; then
        add_field "${name}" "$(truncate_text "${line}" "${max_field_chars}")"
        continue
      fi
      part=$((part + 1))
      field_name="${name}"
      [ "${part}" -gt 1 ] && field_name+=" (continued)"
      add_field "${field_name}" "${chunk}"
      if [ "${#line}" -gt "${max_field_chars}" ]; then
        part=$((part + 1))
        field_name="${name}"
        [ "${part}" -gt 1 ] && field_name+=" (continued)"
        add_field "${field_name}" "$(truncate_text "${line}" "${max_field_chars}")"
        chunk=""
      else
        chunk="${line}"
      fi
    else
      chunk="${candidate}"
    fi
  done <<< "${raw}"

  if [ -n "${chunk}" ]; then
    part=$((part + 1))
    field_name="${name}"
    [ "${part}" -gt 1 ] && field_name+=" (continued)"
    add_field "${field_name}" "${chunk}"
  fi
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

embed_fields_json='[]'
embed_field_chars=0
embed_field_count=0
description=""
title=""
url=""

add_field() {
  local name="$1"
  local value="$2"
  local available value_limit
  [ -z "${value}" ] && return 0

  if [ "${embed_field_count}" -ge "${max_embed_fields}" ]; then
    return 0
  fi

  available=$((max_embed_chars - ${#title} - ${#description} - embed_field_chars - ${#name}))
  [ "${available}" -le 0 ] && return 0
  value_limit="${max_field_chars}"
  [ "${available}" -lt "${value_limit}" ] && value_limit="${available}"
  value="$(truncate_text "${value}" "${value_limit}")"

  embed_fields_json="$(
    EMBED_FIELDS_JSON="${embed_fields_json}" \
    FIELD_NAME="${name}" \
    FIELD_VALUE="${value}" \
    python3 -c 'import json, os; fields=json.loads(os.environ["EMBED_FIELDS_JSON"]); fields.append({"name": os.environ["FIELD_NAME"], "value": os.environ["FIELD_VALUE"], "inline": False}); print(json.dumps(fields))'
  )"
  embed_field_chars=$((embed_field_chars + ${#name} + ${#value}))
  embed_field_count=$((embed_field_count + 1))
}

case "${channel}" in
  releases)
    release_version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
    release_tag="${RELEASE_TAG:?RELEASE_TAG is required}"
    head_sha="${HEAD_SHA:-${GITHUB_SHA:-}}"
    title="Aurral ${release_version} is out!"
    url="https://github.com/${repository}/releases/tag/${release_tag}"
    description="$(cat <<EOF
\`docker pull ghcr.io/${repository}:${release_version}\`
\`docker pull ghcr.io/${repository}:latest\`
EOF
)"
    if [ -n "${head_sha}" ]; then
      base_tag="$(previous_stable_tag "${release_tag}")"
      pull_list="$(collect_merged_pull_lines "${head_sha}" "${base_tag}")"
      issue_list="$(collect_closing_issue_lines_for_pulls "${pull_list}")"
      add_bullet_fields "${pull_list}" "None recorded for this release." "Included"
      add_bullet_fields "${issue_list}" "None" "Linked issues"
    fi
    ;;
  nightly)
    head_sha="${HEAD_SHA:-${GITHUB_SHA:?GITHUB_SHA is required}}"
    run_id="${GITHUB_RUN_ID:-}"
    readiness_issue="${READINESS_ISSUE:-}"
    pull_list="${PULL_LIST:-}"
    issue_list="${ISSUE_LIST:-}"
    title="A new nightly is out!"
    url="https://github.com/${repository}/actions/runs/${run_id}"
    description="$(cat <<EOF
\`docker pull ghcr.io/${repository}:nightly\`
EOF
)"
    if [ -n "${readiness_issue}" ]; then
      description+=$'\n\n'"Release readiness: [view the checklist](https://github.com/${repository}/issues/${readiness_issue})"
    fi
    if [ -z "${pull_list}" ] && [ -n "${head_sha}" ]; then
      base_tag="$(previous_stable_tag)"
      pull_list="$(collect_merged_pull_lines "${head_sha}" "${base_tag}")"
      issue_list="$(collect_closing_issue_lines_for_pulls "${pull_list}")"
    fi
    add_bullet_fields "${pull_list}" "No merged pull requests in this range." "Included"
    add_bullet_fields "${issue_list}" "None" "Linked issues"
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
