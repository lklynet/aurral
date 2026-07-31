# Aurral release guide (proposed)

This is a proposed replacement for `RELEASING.md`. It is not the workflow in effect. Review it, then the workflow changes land and this file replaces `RELEASING.md`.

This document is the maintainer procedure for developing, testing, and releasing Aurral.

## Branch roles

| Branch | Purpose |
| --- | --- |
| `main` | Protected trunk. Every merged change lands here, and every published build comes from here. |
| `feat/*`, `fix/*`, `hotfix/*`, `docs/*`, `ci/*`, `chore/*`, `refactor/*` | Temporary working branches created from `main`. |

There are no long-lived deployment branches. Channels are container tags produced by CI, not branches you move.

`main` is always releasable. Merging is a decision about correctness. Releasing is a separate decision about when users should receive the work.

## Channels

| Channel | Image | Trigger | Version | Git tag |
| --- | --- | --- | --- | --- |
| Preview | `ghcr.io/lklynet/aurral:pr-<number>` | Every push to an open PR | `pr.<number>+<short-sha>` | No |
| Nightly | `ghcr.io/lklynet/aurral:nightly` | Every push to `main` | `nightly.<run>+<short-sha>` | No |
| Beta | `ghcr.io/lklynet/aurral:beta` | Manual dispatch of an `-rc.N` version | `2.1.0-rc.1` | Yes |
| Stable | `ghcr.io/lklynet/aurral:latest`, `:2.1.0`, `:2.1`, `:2` | Manual dispatch of a stable version | `2.1.0` | Yes |

Preview and nightly builds create no Git tags. Their identity is the commit they were built from, which is what the update check compares.

## Version source

A version number is written down only where a human has already decided to publish, which is the beta and stable dispatch inputs. Nothing infers or guesses a future version.

Aurral uses Semantic Versioning:

- Major (`3.0.0`): incompatible configuration, API, storage, or user workflow change.
- Minor (`2.1.0`): backward-compatible feature or integration.
- Patch (`2.0.1`): backward-compatible bug, security, dependency, or performance fix.

The dispatch workflow reads Conventional Commit titles merged since the last stable tag and offers the resulting version as the default input. It is a suggestion. The maintainer confirms or overrides it, and no push ever publishes a stable release on its own.

Contributors do not change product versions. `package.json` is package metadata, not a release decision.

## Normal change workflow

1. Synchronize `main` and create a short-lived branch:

   ```bash
   git fetch origin --prune
   git switch main
   git pull --ff-only origin main
   git switch -c feat/short-description
   ```

2. Implement and validate the change.
3. Push the working branch and open a draft PR against `main`.
4. CI validates the branch and publishes a preview container built from the PR's merge commit, so the image is current `main` plus the change rather than the change on a stale base:

   ```bash
   docker pull ghcr.io/lklynet/aurral:pr-464
   ```

5. Test that image. Push fixes to the branch, and each push replaces the preview image.
6. Give the PR a Conventional Commit title such as `feat: add playlist sharing` or `fix: prevent duplicate imports`.
7. Complete the PR checklist and use **Squash and merge**.
8. Delete the working branch. GitHub normally does this automatically.

Preview images are deleted when the PR closes. Several PRs can be in testing at once because each owns its own image, and nothing is force-pushed or held exclusively.

## Nightly

Every merge to `main` publishes `ghcr.io/lklynet/aurral:nightly` automatically. No action is required.

Nightly is the channel for anyone who wants merged work immediately, including you. It accumulates everything merged since the last release, so integration problems surface between releases rather than during one.

## Publish a release candidate

Cut a candidate when `main` holds the work you intend to ship and you want wider testing before it becomes stable.

1. Open **Actions → Release → Run workflow**.
2. Select `main` and enter the candidate version, for example `2.1.0-rc.1`.
3. The workflow validates, publishes `ghcr.io/lklynet/aurral:beta` and `:2.1.0-rc.1`, and creates the annotated tag `v2.1.0-rc.1`.

Fix problems by merging to `main` and cutting `2.1.0-rc.2`. Candidates are never promoted in place, and a candidate is never converted into the stable image.

## Publish a stable release

Merging a PR does not publish a release. Neither does cutting a candidate.

Release on a cadence rather than per merge. A minor release every two to four weeks is the target, and a patch release goes out as soon as a user-facing bug warrants it. Batching keeps release notes meaningful and keeps the update banner from firing at self-hosters for every merge.

1. Make sure that the intended code is on `main` and CI passed.
2. Open **Actions → Release → Run workflow**.
3. Select `main`, confirm or override the suggested version, and enter it without `v`, for example `2.1.0`.
4. Watch the workflow through validation, image publication, annotated tag creation, and GitHub Release publication.
5. Make sure that the exact version and moving aliases exist:

   ```text
   ghcr.io/lklynet/aurral:2.1.0
   ghcr.io/lklynet/aurral:2.1
   ghcr.io/lklynet/aurral:2
   ghcr.io/lklynet/aurral:latest
   ```

If `release-notes/<version>.md` exists, the workflow uses it as curated release notes. Otherwise GitHub generates notes from merged PRs and `.github/release.yml`.

Stable tags are permanent. Never move, reuse, or delete a published stable tag. Correct a bad release with a new patch version.

## Hotfixes

Create `hotfix/short-description` from `main`, use a `fix:` PR title, test the preview image, merge, and dispatch a new patch version. A hotfix skips the release candidate. Do not patch a published tag or container in place.

## Rollback

Redeploy the previous exact stable container, such as `ghcr.io/lklynet/aurral:2.0.0`. Do not move `latest` by hand and do not change an existing Git tag. Prepare a new patch release containing the correction.

## What changes from the current workflow

Delete this section when the proposal is adopted.

| Current | Proposed | Reason |
| --- | --- | --- |
| `./scripts/deploy-channel.sh dev feat/x` force-pushes `dev` to one feature branch | PR preview image per PR | One feature at a time is the current hard limit, enforced by the script's own equality check against `origin/dev` |
| `dev` and `test` build from the feature branch's stale base | Preview builds from the PR merge commit | The tested artifact and the merged artifact are currently not the same code |
| `nextPatchVersion` guesses the next version to label prereleases | No version on preview or nightly | A feature branch is currently tagged `2.0.2-dev.1` even when it ships as `2.1.0`, and that tag is permanent |
| Every deployment creates a Git tag | Tags only for `-rc.N` and stable | The repository holds 375 prerelease tags against 208 stable ones |
| `test` channel requires `origin/dev` to be the identical commit | Beta is cut from `main` | Promotion is currently blocked whenever any other work has touched `dev` |
| `UpdateBanner` lists every `v` tag through the GitHub API | Nightly and preview compare the commit against `main`, beta and stable compare tags | Untagged channels need a commit comparison, and it is one request instead of a full tag listing |

Files affected: `.github/workflows/deploy.yml` becomes a nightly build on `main`, a new preview workflow is added, `.github/workflows/release.yml` gains the candidate path and the version suggestion, `lib/release-version.js` drops `nextPatchVersion` and swaps `dev|test` for `rc`, `frontend/src/components/UpdateBanner.jsx` gains the commit comparison, `scripts/deploy-channel.sh` is deleted, `.github/pull_request_template.md` replaces its `dev` and `test` checkboxes with the preview image, and `.cursor/rules/aurral-git-workflow.mdc` is rewritten.

Existing `-dev.N` and `-test.N` tags stay as history. Nothing renames or deletes them.
