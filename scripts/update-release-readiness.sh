#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
head_sha="${HEAD_SHA:-${GITHUB_SHA:?GITHUB_SHA is required}}"
run_id="${GITHUB_RUN_ID:-unknown}"
readiness_marker='<!-- aurral-release-readiness -->'
status_marker='<!-- aurral-release-readiness-status -->'

ensure_labels() {
  gh label create release-readiness \
    --repo "${repository}" \
    --color FBCA04 \
    --description "Tracks testing and approval for the next stable release." \
    --force >/dev/null
  gh label create release-ready \
    --repo "${repository}" \
    --color 0E8A16 \
    --description "Release readiness checks are complete for the current main commit." \
    --force >/dev/null
  gh label create released \
    --repo "${repository}" \
    --color 5319E7 \
    --description "Included in a stable release." \
    --force >/dev/null
}

find_open_record() {
  gh api --paginate \
    "repos/${repository}/issues?state=open&labels=release-readiness&per_page=100" \
    --jq '.[] | select(.pull_request == null and ((.body // "") | contains("<!-- aurral-release-readiness -->"))) | .number' \
    | awk 'NR == 1 { print }'
}

find_status_comment() {
  local issue_number="$1"
  gh api --paginate \
    "repos/${repository}/issues/${issue_number}/comments" \
    --jq '.[] | select(.user.login == "github-actions[bot]" and ((.body // "") | contains("<!-- aurral-release-readiness-status -->"))) | .id' \
    | awk 'NR == 1 { print }'
}

update_status_comment() {
  local issue_number="$1"
  local body="$2"
  local comment_id
  comment_id="$(find_status_comment "${issue_number}")"

  if [ -n "${comment_id}" ]; then
    gh api \
      --method PATCH \
      "repos/${repository}/issues/comments/${comment_id}" \
      -f "body=${body}" >/dev/null
  else
    gh api \
      --method POST \
      "repos/${repository}/issues/${issue_number}/comments" \
      -f "body=${body}" >/dev/null
  fi
}

write_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "${GITHUB_OUTPUT}"
  fi
}

write_output_multiline() {
  local name="$1"
  local value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      printf '%s<<AURRAL_EOF\n' "${name}"
      printf '%s\n' "${value}"
      printf 'AURRAL_EOF\n'
    } >> "${GITHUB_OUTPUT}"
  fi
}

pin_issue() {
  local issue_number="$1"
  local err
  if err="$(gh issue pin "${issue_number}" --repo "${repository}" 2>&1)"; then
    return 0
  fi
  if printf '%s\n' "${err}" | grep -qi 'already pinned'; then
    return 0
  fi
  printf '%s\n' "${err}" >&2
  return 1
}

unpin_issue() {
  local issue_number="$1"
  local err
  if err="$(gh issue unpin "${issue_number}" --repo "${repository}" 2>&1)"; then
    return 0
  fi
  if printf '%s\n' "${err}" | grep -qi 'not pinned'; then
    return 0
  fi
  printf '%s\n' "${err}" >&2
  return 1
}

resolve_tag_commit() {
  local tag_ref="$1"
  local tag_object tag_type tag_sha

  tag_object="$(gh api "repos/${repository}/git/ref/tags/${tag_ref}" --jq '.object | "\(.type)\t\(.sha)"')"
  IFS=$'\t' read -r tag_type tag_sha <<< "${tag_object}"

  if [ "${tag_type}" = "tag" ]; then
    tag_sha="$(gh api "repos/${repository}/git/tags/${tag_sha}" --jq '.object.sha')"
  fi

  printf '%s\n' "${tag_sha}"
}

if [ "${mode}" = "check" ]; then
  if [ -n "${RELEASE_TAG:-}" ] && gh release view "${RELEASE_TAG}" >/dev/null 2>&1; then
    published_sha="$(resolve_tag_commit "${RELEASE_TAG}")"
    if [ "${published_sha}" != "${head_sha}" ]; then
      echo "Stable release ${RELEASE_TAG} already points to ${published_sha}, not ${head_sha}; refusing to republish release aliases." >&2
      exit 1
    fi

    write_output existing_release true
    echo "Stable release ${RELEASE_TAG} already exists at ${head_sha}; allowing lifecycle reconciliation."
    exit 0
  fi

  readiness_issue="$(find_open_record)"
  if [ -z "${readiness_issue}" ]; then
    echo "No open release-readiness issue was found. Run a successful nightly build first." >&2
    exit 1
  fi

  labels="$(gh api "repos/${repository}/issues/${readiness_issue}" --jq '.labels[].name')"
  if ! printf '%s\n' "${labels}" | grep -Fxq release-ready; then
    issue_url="$(gh api "repos/${repository}/issues/${readiness_issue}" --jq '.html_url')"
    echo "Release readiness issue ${issue_url} is not marked release-ready." >&2
    echo "Complete its checklist and apply the release-ready label before publishing." >&2
    exit 1
  fi

  status_comment="$(find_status_comment "${readiness_issue}")"
  status_body=""
  if [ -n "${status_comment}" ]; then
    status_body="$(gh api "repos/${repository}/issues/comments/${status_comment}" --jq '.body')"
  fi
  if [[ "${status_body}" != *"Source commit: \`${head_sha}\`"* ]]; then
    echo "Release readiness is not recorded against current main ${head_sha}." >&2
    echo "Wait for the nightly build for this commit, then retest and reapply release-ready." >&2
    exit 1
  fi

  write_output existing_release false
  echo "Release readiness approved for ${head_sha}."
  exit 0
fi

stable_tags="$(gh api --paginate \
  "repos/${repository}/git/matching-refs/tags/v" \
  --jq '.[].ref | sub("^refs/tags/"; "")')"

case "${mode}" in
  nightly)
    nightly_version="${NIGHTLY_VERSION:?NIGHTLY_VERSION is required}"
    base_tag="$(printf '%s\n' "${stable_tags}" | awk 'NF' | sort -V | tail -n1)"
    ;;
  stable)
    release_tag="${RELEASE_TAG:?RELEASE_TAG is required}"
    release_version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
    base_tag="$(printf '%s\n' "${stable_tags}" | awk 'NF' | sort -V | awk -v target="${release_tag}" '$0 == target { print previous; found=1; exit } { previous=$0 } END { if (!found) print previous }')"
    ;;
  *)
    echo "Usage: $0 nightly|stable|check" >&2
    exit 2
    ;;
esac

if [ -n "${base_tag}" ]; then
  change_url="https://github.com/${repository}/compare/${base_tag}...${head_sha}"
else
  change_url="https://github.com/${repository}/commit/${head_sha}"
fi

if [ "${mode}" = "nightly" ]; then
  if [ -n "${base_tag}" ]; then
    change_range="${base_tag}...${head_sha:0:7}"
  else
    change_range="${head_sha:0:7}"
  fi

  changes="$(bash "$(dirname "$0")/list-release-changes.sh" "${base_tag}" "${head_sha}")"
  pull_list=""
  issue_list=""
  while IFS=$'\t' read -r kind number _labels url title; do
    case "${kind}" in
      pull) pull_list+="- [#${number}](${url}) ${title}"$'\n' ;;
      issue) issue_list+="- [#${number}](${url}) ${title}"$'\n' ;;
    esac
  done <<< "${changes}"
  pull_list="${pull_list%$'\n'}"
  issue_list="${issue_list%$'\n'}"

  if [ -z "${pull_list}" ]; then
    echo "No merged pull requests found; no release-readiness issue is needed."
    exit 0
  fi
fi

if [ "${mode}" = "nightly" ]; then
  ensure_labels
  readiness_issue="$(find_open_record)"
  if [ -z "${readiness_issue}" ]; then
    readiness_body="$(cat <<EOF
${readiness_marker}
# Release readiness: next stable

This issue tracks user-level testing for the next Aurral stable release.

The automation updates the candidate and included-change status comment below. Keep manual test evidence and decisions in this issue. Apply the \`release-ready\` label only after the checklist and required testing are complete for the current source commit.

## Maintainer checklist

- [ ] Nightly validation passed
- [ ] Affected areas tested against the current nightly build
- [ ] Upgrade, migration, and rollback behavior checked where applicable
- [ ] No blocking nightly issues remain
- [ ] Release approved

## Test evidence

Add comments with the tester, date, exact nightly build, affected area, and result.
EOF
    )"
    readiness_issue="$(gh api \
      --method POST \
      "repos/${repository}/issues" \
      -f "title=Release readiness: next stable" \
      -f "body=${readiness_body}" \
      --jq '.number')"
    gh issue edit "${readiness_issue}" --repo "${repository}" --add-label release-readiness >/dev/null
  else
    previous_status_comment="$(find_status_comment "${readiness_issue}")"
    previous_status_body=""
    if [ -n "${previous_status_comment}" ]; then
      previous_status_body="$(gh api "repos/${repository}/issues/comments/${previous_status_comment}" --jq '.body')"
    fi
    if [[ "${previous_status_body}" != *"Source commit: \`${head_sha}\`"* ]]; then
      gh issue edit "${readiness_issue}" --repo "${repository}" --remove-label release-ready >/dev/null
    fi
  fi

  pin_issue "${readiness_issue}"

  status_body="$(cat <<EOF
${status_marker}
### Current nightly candidate

- Image: \`ghcr.io/${repository}:nightly\`
- Build: \`${nightly_version}\`
- Source commit: \`${head_sha}\`
- Changes: [\`${change_range}\`](${change_url})
- [View the nightly workflow](https://github.com/${repository}/actions/runs/${run_id})

### Included pull requests

${pull_list}

### Linked closing issues

${issue_list:-None}

The candidate above is the build that should be used for readiness testing. A nightly built from a newer source commit replaces this status and revokes the \`release-ready\` label until the current candidate is retested.
EOF
  )"
  update_status_comment "${readiness_issue}" "${status_body}"
  write_output readiness_issue "${readiness_issue}"
  write_output change_url "${change_url}"
  write_output change_range "${change_range}"
  write_output_multiline pull_list "${pull_list}"
  write_output_multiline issue_list "${issue_list:-}"
  echo "Updated release-readiness issue #${readiness_issue}."
  exit 0
fi

ensure_labels
readiness_issue="$(find_open_record)"
if [ -z "${readiness_issue}" ]; then
  echo "No open release-readiness issue found after stable release; nothing to close."
  exit 0
fi

previous_status_comment="$(find_status_comment "${readiness_issue}")"
previous_status_body=""
if [ -n "${previous_status_comment}" ]; then
  previous_status_body="$(gh api "repos/${repository}/issues/comments/${previous_status_comment}" --jq '.body')"
fi
preserved_status_body="${previous_status_body#${status_marker}}"
preserved_status_body="${preserved_status_body//### Current nightly candidate/### Included changes at release}"
if [ -z "${preserved_status_body}" ]; then
  preserved_status_body=$'\n### Included changes at release\n\nThe previous nightly status comment was unavailable; use the linked change range above.'
fi

status_body="$(cat <<EOF
${status_marker}
### Released

The readiness candidate was published as stable release \`${release_version}\`.

- Stable image: \`ghcr.io/${repository}:${release_version}\`
- Source commit: \`${head_sha}\`
- [View the release](https://github.com/${repository}/releases/tag/${release_tag})
- [View the included changes](${change_url})

${preserved_status_body}
EOF
  )"
update_status_comment "${readiness_issue}" "${status_body}"
gh issue edit "${readiness_issue}" \
  --repo "${repository}" \
  --title "Release readiness: ${release_version}" \
  --add-label released \
  --remove-label release-ready >/dev/null
gh issue close "${readiness_issue}" --repo "${repository}" >/dev/null
unpin_issue "${readiness_issue}"
echo "Closed release-readiness issue #${readiness_issue} for ${release_version}."
