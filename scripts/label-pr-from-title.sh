#!/usr/bin/env bash
set -euo pipefail

repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
pr_number="${PR_NUMBER:?PR_NUMBER is required}"
pr_title="${PR_TITLE:?PR_TITLE is required}"

managed_labels=(enhancement bug documentation)

commit_type="$(printf '%s\n' "${pr_title}" | sed -nE 's/^([A-Za-z]+)(\([^)]*\))?\!?:[[:space:]].*/\1/p' | tr '[:upper:]' '[:lower:]')"

if [ -z "${commit_type}" ]; then
  echo "Pull request #${pr_number} title has no Conventional Commit type; leaving changelog labels unchanged."
  exit 0
fi

desired_label=""
desired_color=""
case "${commit_type}" in
  feat)
    desired_label=enhancement
    desired_color=a2eeef
    ;;
  fix)
    desired_label=bug
    desired_color=d73a4a
    ;;
  docs)
    desired_label=documentation
    desired_color=0075ca
    ;;
esac

remove_issue_label() {
  local label="$1"
  local output
  local status

  if output="$(gh api \
      --method DELETE \
      "repos/${repository}/issues/${pr_number}/labels/${label}" \
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

if [ -n "${desired_label}" ]; then
  gh label create "${desired_label}" \
    --repo "${repository}" \
    --color "${desired_color}" \
    --force >/dev/null
  gh api \
    --method POST \
    "repos/${repository}/issues/${pr_number}/labels" \
    -f "labels[]=${desired_label}" >/dev/null
  echo "Labeled pull request #${pr_number} with ${desired_label} from ${commit_type}: title."
fi

for label in "${managed_labels[@]}"; do
  if [ "${label}" = "${desired_label}" ]; then
    continue
  fi
  remove_issue_label "${label}"
done

if [ -z "${desired_label}" ]; then
  echo "Pull request #${pr_number} type ${commit_type} has no changelog label mapping; removed managed changelog labels if present."
fi
