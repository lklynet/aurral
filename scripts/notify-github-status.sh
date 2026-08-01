#!/usr/bin/env bash
set -euo pipefail

status="${1:-}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
head_sha="${GITHUB_SHA:?GITHUB_SHA is required}"
owner="${repository%%/*}"
repo="${repository#*/}"

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
    base_tag="$(printf '%s\n' "${stable_tags}" | awk -v exclude="${release_tag}" '$0 != exclude' | sort -V | tail -n1)"
    ;;
  *)
    echo "Usage: $0 nightly|stable" >&2
    exit 2
    ;;
esac

if [ -n "${base_tag}" ]; then
  commit_shas="$(gh api --paginate \
    "repos/${repository}/compare/${base_tag}...${head_sha}" \
    --jq '.commits[].sha')"
else
  commit_shas="${head_sha}"
fi

declare -A pull_numbers=()
while IFS= read -r commit_sha; do
  [ -z "${commit_sha}" ] && continue
  associated_pulls="$(gh api --paginate \
    "repos/${repository}/commits/${commit_sha}/pulls" \
    --jq '.[].number')"
  while IFS= read -r pull_number; do
    [ -z "${pull_number}" ] && continue
    pull_numbers["${pull_number}"]=1
  done <<< "${associated_pulls}"
done <<< "${commit_shas}"

if [ "${#pull_numbers[@]}" -eq 0 ]; then
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

declare -A target_numbers=()
for pull_number in "${!pull_numbers[@]}"; do
  target_numbers["${pull_number}"]=1
  closing_issues="$(gh api graphql \
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
  while IFS= read -r issue_number; do
    [ -z "${issue_number}" ] && continue
    target_numbers["${issue_number}"]=1
  done <<< "${closing_issues}"
done

for target_number in $(printf '%s\n' "${!target_numbers[@]}" | sort -n); do
  comment_state="$(gh api --paginate \
    "repos/${repository}/issues/${target_number}/comments" \
    --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | contains("<!-- aurral-release-status -->"))) | "\(.id)\t\((if (.body | contains("### Included in stable release")) then "stable" else "nightly" end))"' \
    | awk 'NR == 1 { print }')"
  comment_id="${comment_state%%$'\t'*}"
  comment_status="${comment_state#*$'\t'}"

  if [ "${comment_status}" = "${status}" ]; then
    continue
  fi

  if [ "${status}" = "nightly" ]; then
    gh issue edit "${target_number}" \
      --repo "${repository}" \
      --add-label nightly \
      --remove-label released >/dev/null
    comment_body="$(cat <<EOF
<!-- aurral-release-status -->
### Available on nightly

A linked pull request was merged into \`main\` and is now included in the latest nightly build.

\`\`\`bash
docker pull ghcr.io/${repository}:nightly
\`\`\`

Build: \`${nightly_version}\`  
[View the nightly workflow](https://github.com/${repository}/actions/runs/${GITHUB_RUN_ID}) · [View changes on main](https://github.com/${repository}/commits/main)
EOF
    )"
  else
    gh issue edit "${target_number}" \
      --repo "${repository}" \
      --add-label released \
      --remove-label nightly >/dev/null
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
done
