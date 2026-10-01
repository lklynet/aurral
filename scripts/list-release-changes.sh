#!/usr/bin/env bash
set -euo pipefail

base_tag="${1:-}"
head_sha="${2:?Usage: $0 <base-tag> <head-sha>}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
owner="${repository%%/*}"
repo="${repository#*/}"

pull_fields='
  associatedPullRequests(first: 5) {
    nodes {
      number
      title
      url
      labels(first: 20) { nodes { name } }
      closingIssuesReferences(first: 25) {
        nodes {
          number
          title
          url
          labels(first: 20) { nodes { name } }
        }
      }
    }
  }'

line_def='def line($kind): [$kind, (.number | tostring), ("," + ([.labels.nodes[].name + ","] | join(""))), .url, .title] | join("\t");'
pull_lines='.associatedPullRequests.nodes[] | line("pull"), (.closingIssuesReferences.nodes[] | line("issue"))'

if [ -n "${base_tag}" ]; then
  gh api graphql --paginate \
    -f query="query(\$owner: String!, \$repo: String!, \$base: String!, \$head: String!, \$endCursor: String) {
      repository(owner: \$owner, name: \$repo) {
        ref(qualifiedName: \$base) {
          compare(headRef: \$head) {
            commits(first: 100, after: \$endCursor) {
              pageInfo { hasNextPage endCursor }
              nodes { ${pull_fields} }
            }
          }
        }
      }
    }" \
    -f "owner=${owner}" \
    -f "repo=${repo}" \
    -f "base=refs/tags/${base_tag}" \
    -f "head=${head_sha}" \
    --jq "${line_def} .data.repository.ref.compare.commits.nodes[] | ${pull_lines}"
else
  gh api graphql \
    -f query="query(\$owner: String!, \$repo: String!, \$head: String!) {
      repository(owner: \$owner, name: \$repo) {
        object(expression: \$head) { ... on Commit { ${pull_fields} } }
      }
    }" \
    -f "owner=${owner}" \
    -f "repo=${repo}" \
    -f "head=${head_sha}" \
    --jq "${line_def} .data.repository.object | ${pull_lines}"
fi | sort -t $'\t' -k1,1 -k2,2n -u
