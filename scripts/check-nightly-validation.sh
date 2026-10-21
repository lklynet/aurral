#!/usr/bin/env bash
set -euo pipefail

repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
sha="${GITHUB_SHA:?GITHUB_SHA is required}"

api() {
  local output
  if output="$(gh api "$@" 2>/dev/null)"; then
    printf '%s' "${output}"
  fi
}

validated=false
head_sha="$(api "repos/${repository}/commits/${sha}/pulls" \
  --jq "[.[] | select(.merge_commit_sha == \"${sha}\")][0].head.sha // empty")"

if [[ "${head_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  tree="$(api "repos/${repository}/git/commits/${sha}" --jq '.tree.sha')"
  head_tree="$(api "repos/${repository}/git/commits/${head_sha}" --jq '.tree.sha')"
  passed="$(api "repos/${repository}/commits/${head_sha}/check-runs?check_name=validate%20%2F%20validate&filter=latest" \
    --jq '[.check_runs[] | select(.app.slug == "github-actions" and .conclusion == "success")] | length')"

  if [ -n "${tree}" ] && [ "${tree}" = "${head_tree}" ] && [ "${passed:-0}" -gt 0 ]; then
    validated=true
    echo "Pull request head ${head_sha} passed validation with the same tree as ${sha}."
  else
    echo "Pull request head ${head_sha} does not prove ${sha}: tree ${tree:-unknown} vs ${head_tree:-unknown}, ${passed:-0} passing validations."
  fi
else
  echo "Could not find a merged pull request that produced ${sha}."
fi

if [ "${validated}" != "true" ]; then
  echo "Running full validation for ${sha}."
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "validated=${validated}" >> "${GITHUB_OUTPUT}"
fi
