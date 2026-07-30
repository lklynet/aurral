#!/bin/sh

set -eu

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy-channel.sh <dev|test> <remote-source-branch> [--yes]

Examples:
  ./scripts/deploy-channel.sh dev feat/playlist-sharing
  ./scripts/deploy-channel.sh test feat/playlist-sharing

The source branch must already be pushed to origin. Promoting to test is allowed
only when origin/dev points to the same commit.
EOF
}

channel="${1:-}"
source_branch="${2:-}"
assume_yes="${3:-}"

case "$channel" in
  dev|test) ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if [ -z "$source_branch" ]; then
  usage >&2
  exit 2
fi

if [ "$assume_yes" != "" ] && [ "$assume_yes" != "--yes" ]; then
  usage >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "Run this command from inside the Aurral repository." >&2
  exit 1
fi
cd "$repo_root"

git fetch origin --prune

source_ref="refs/remotes/origin/${source_branch}"
if ! source_sha="$(git rev-parse --verify "${source_ref}^{commit}" 2>/dev/null)"; then
  echo "Remote source branch origin/${source_branch} does not exist." >&2
  echo "Push the feature branch before deploying it." >&2
  exit 1
fi

if [ "$channel" = "test" ]; then
  if ! dev_sha="$(git rev-parse --verify "refs/remotes/origin/dev^{commit}" 2>/dev/null)"; then
    echo "origin/dev does not exist. Deploy this commit to dev first." >&2
    exit 1
  fi
  if [ "$dev_sha" != "$source_sha" ]; then
    echo "Test promotion blocked: origin/dev is not the requested source commit." >&2
    echo "origin/dev:             $dev_sha" >&2
    echo "origin/${source_branch}: $source_sha" >&2
    exit 1
  fi
fi

channel_ref="refs/remotes/origin/${channel}"
if ! channel_sha="$(git rev-parse --verify "${channel_ref}^{commit}" 2>/dev/null)"; then
  echo "Remote deployment branch origin/${channel} does not exist." >&2
  exit 1
fi

cat <<EOF
Deploy Aurral to ${channel}

Source:  origin/${source_branch}
Commit:  ${source_sha}
Current: ${channel_sha}
Target:  origin/${channel}
EOF

if [ "$assume_yes" != "--yes" ]; then
  printf "Continue? [y/N] "
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *)
      echo "Deployment cancelled."
      exit 0
      ;;
  esac
fi

git push \
  --force-with-lease="refs/heads/${channel}:${channel_sha}" \
  origin \
  "${source_sha}:refs/heads/${channel}"

echo "origin/${channel} now points to ${source_sha}."
echo "The Deploy Prerelease workflow will validate and publish the ${channel} container."
