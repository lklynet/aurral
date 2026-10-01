#!/usr/bin/env bash
set -euo pipefail

status="${1:-}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
head_sha="${HEAD_SHA:-${GITHUB_SHA:?GITHUB_SHA is required}}"

stable_tags="$(gh api --paginate \
  "repos/${repository}/git/matching-refs/tags/v" \
  --jq '.[].ref | sub("^refs/tags/"; "")')"

case "${status}" in
  nightly)
    base_tag="$(printf '%s\n' "${stable_tags}" | sort -V | tail -n1)"
    nightly_version="${NIGHTLY_VERSION:?NIGHTLY_VERSION is required}"
    ;;
  stable)
    release_tag="${RELEASE_TAG:?RELEASE_TAG is required}"
    release_version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
    base_tag="$(printf '%s\n' "${stable_tags}" | awk 'NF' | sort -V | awk -v target="${release_tag}" '$0 == target { print previous; found=1; exit } { previous=$0 } END { if (!found) print previous }')"
    ;;
  *)
    echo "Usage: $0 nightly|stable" >&2
    exit 2
    ;;
esac

changes="$(bash "$(dirname "$0")/list-release-changes.sh" "${base_tag}" "${head_sha}")"

if ! grep -q '^pull'$'\t' <<< "${changes}"; then
  echo "No merged pull requests found for ${status} notification."
  exit 0
fi

gh label create nightly \
  --repo "${repository}" \
  --color 0E8A16 \
  --description "Available in the nightly image but not yet in a stable release." \
  --force >/dev/null
gh label create released \
  --repo "${repository}" \
  --color 5319E7 \
  --description "Included in a stable release." \
  --force >/dev/null

remove_issue_label() {
  local target_number="$1"
  local label="$2"
  local output
  local status

  if output="$(gh api \
      --method DELETE \
      "repos/${repository}/issues/${target_number}/labels/${label}" \
      --include \
      --silent 2>&1)"; then
    return 0
  fi

  status="$(printf '%s\n' "${output}" | awk 'NR == 1 { print $2; exit }')"
  if [ "${status}" = "404" ]; then
    return 0
  fi

  printf '%s\n' "${output}" >&2
  return 1
}

set_status_label() {
  local target_number="$1"
  local add_label="$2"
  local remove_label="$3"

  gh api \
    --method POST \
    "repos/${repository}/issues/${target_number}/labels" \
    -f "labels[]=${add_label}" >/dev/null
  for label in "${remove_label}" in-progress; do
    remove_issue_label "${target_number}" "${label}"
  done
}

if [ "${status}" = "nightly" ]; then
  done_label=nightly
  other_label=released
else
  done_label=released
  other_label=nightly
fi

while IFS=$'\t' read -r -u 3 _kind target_number labels _url _title; do
  if [[ "${labels}" == *",${done_label},"* && "${labels}" != *",${other_label},"* ]]; then
    continue
  fi

  comment_state="$(gh api --paginate \
    "repos/${repository}/issues/${target_number}/comments" \
    --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | contains("<!-- aurral-release-status -->"))) | "\(.id)\t\((if (.body | contains("### Included in stable release")) then "stable" else "nightly" end))"' \
    | awk 'NR == 1 { print }')"
  comment_id="${comment_state%%$'\t'*}"
  comment_status="${comment_state#*$'\t'}"

  if [ "${comment_status}" = "${status}" ]; then
    set_status_label "${target_number}" "${done_label}" "${other_label}"
    continue
  fi

  if [ "${status}" = "nightly" ]; then
    comment_body="$(cat <<EOF
<!-- aurral-release-status -->
### Available on nightly

A linked pull request was merged into \`main\` and is now included in the latest nightly build. Linked issues stay open until this change ships in a stable release.

\`\`\`bash
docker pull ghcr.io/${repository}:nightly
\`\`\`

- Build: \`${nightly_version}\`
- [View the nightly workflow](https://github.com/${repository}/actions/runs/${GITHUB_RUN_ID}) · [View changes on main](https://github.com/${repository}/commits/main)
EOF
    )"
  else
    comment_body="$(cat <<EOF
<!-- aurral-release-status -->
### Included in stable release ${release_version}

This change is included in the Aurral ${release_version} release.

\`\`\`bash
docker pull ghcr.io/${repository}:${release_version}
\`\`\`

[View the release](https://github.com/${repository}/releases/tag/${release_tag})
EOF
    )"
  fi

  if [ -n "${comment_id}" ]; then
    gh api \
      --method PATCH \
      "repos/${repository}/issues/comments/${comment_id}" \
      -f "body=${comment_body}" >/dev/null
  else
    gh api \
      --method POST \
      "repos/${repository}/issues/${target_number}/comments" \
      -f "body=${comment_body}" >/dev/null
  fi
  set_status_label "${target_number}" "${done_label}" "${other_label}"
done 3<<< "${changes}"

if [ "${status}" = "stable" ]; then
  for issue_number in $(awk -F '\t' '$1 == "issue" { print $2 }' <<< "${changes}"); do
    issue_state="$(gh api \
      "repos/${repository}/issues/${issue_number}" \
      --jq 'if .pull_request then "pull" else .state end')"
    if [ "${issue_state}" != "open" ]; then
      continue
    fi
    gh issue close "${issue_number}" \
      --repo "${repository}" \
      --reason completed >/dev/null
    echo "Closed linked issue #${issue_number} for stable release ${release_version}."
  done
fi
