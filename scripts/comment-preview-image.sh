#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${REPOSITORY:?REPOSITORY is required}"
: "${RUN_ID:?RUN_ID is required}"

COMMENT_BODY="$(cat <<EOF
<!-- aurral-preview-image -->
## Aurral preview image ready

This image was rebuilt from the latest push to this pull request. It will be replaced when you push another change.

\`\`\`bash
docker pull ghcr.io/${REPOSITORY}:${IMAGE_TAG}
\`\`\`

To test it with your existing Docker Compose setup:

1. Back up your Aurral config.
2. Temporarily change the Aurral service image to \`ghcr.io/${REPOSITORY}:${IMAGE_TAG}\`.
3. Run \`docker compose pull aurral && docker compose up -d aurral\`.
4. Exercise the behavior changed by this pull request.
5. Restore the image reference that was configured before testing.

[View the CI run](https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}) · [Report a problem](https://github.com/${REPOSITORY}/issues)
EOF
)"

COMMENT_ID="$(gh api --paginate \
  "repos/${REPOSITORY}/issues/${PR_NUMBER}/comments" \
  --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | contains("<!-- aurral-preview-image -->"))) | .id' | head -n1)"

if [ -n "${COMMENT_ID}" ]; then
  gh api \
    --method PATCH \
    "repos/${REPOSITORY}/issues/comments/${COMMENT_ID}" \
    -f "body=${COMMENT_BODY}" >/dev/null
else
  gh pr comment "${PR_NUMBER}" \
    --repo "${REPOSITORY}" \
    --body "${COMMENT_BODY}" >/dev/null
fi

OWNER="${REPOSITORY%%/*}"
REPO="${REPOSITORY#*/}"
ISSUE_MARKER="aurral-preview-issue-${PR_NUMBER}"
CLOSING_ISSUES="$(gh api graphql \
  -f query='query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 100) {
          nodes { number }
        }
      }
    }
  }' \
  -f "owner=${OWNER}" \
  -f "repo=${REPO}" \
  -F "number=${PR_NUMBER}" \
  --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[]?.number')"

if [ -n "${CLOSING_ISSUES}" ]; then
  gh label create in-progress \
    --repo "${REPOSITORY}" \
    --color FBCA04 \
    --description "Linked pull request is open and being worked on." \
    --force >/dev/null
fi

while IFS= read -r issue_number; do
  [ -z "${issue_number}" ] && continue

  ISSUE_COMMENT_BODY="$(cat <<EOF
<!-- ${ISSUE_MARKER} -->
## Aurral preview image ready

[Pull request #${PR_NUMBER}](https://github.com/${REPOSITORY}/pull/${PR_NUMBER}), which is linked to this issue, has a preview image ready to test before it is merged into \`nightly\`. It will be replaced when the pull request changes.

\`\`\`bash
docker pull ghcr.io/${REPOSITORY}:${IMAGE_TAG}
\`\`\`

To test it with your existing Docker Compose setup:

1. Back up your Aurral config.
2. Temporarily change the Aurral service image to \`ghcr.io/${REPOSITORY}:${IMAGE_TAG}\`.
3. Run \`docker compose pull aurral && docker compose up -d aurral\`.
4. Exercise the behavior changed by the pull request.
5. Restore the image reference that was configured before testing.

Please report your results and approval on the pull request before it is merged into nightly.

[View the CI run](https://github.com/${REPOSITORY}/actions/runs/${RUN_ID})
EOF
  )"

  COMMENT_ID="$(gh api --paginate \
    "repos/${REPOSITORY}/issues/${issue_number}/comments" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"<!-- ${ISSUE_MARKER} -->\"))) | .id" | head -n1)"

  if [ -n "${COMMENT_ID}" ]; then
    gh api \
      --method PATCH \
      "repos/${REPOSITORY}/issues/comments/${COMMENT_ID}" \
      -f "body=${ISSUE_COMMENT_BODY}" >/dev/null
  else
    gh api \
      --method POST \
      "repos/${REPOSITORY}/issues/${issue_number}/comments" \
      -f "body=${ISSUE_COMMENT_BODY}" >/dev/null
  fi

  gh api \
    --method POST \
    "repos/${REPOSITORY}/issues/${issue_number}/labels" \
    -f "labels[]=in-progress" >/dev/null
done <<< "${CLOSING_ISSUES}"
