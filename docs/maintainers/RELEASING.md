# Aurral release guide

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
| Nightly | `ghcr.io/lklynet/aurral:nightly` | Every push to `main`, or manual reconciliation | `nightly.<run>+<short-sha>` | No |
| Stable | `ghcr.io/lklynet/aurral:latest`, `:2.1.0`, `:2.1`, `:2` | Manual dispatch of a stable version | `2.1.0` | Yes |

Preview and nightly builds create no Git tags. Their identity is the commit they were built from, which is what the update check compares.

Preview images are `linux/amd64` only, because emulating arm64 roughly doubles a build that runs on every push to every open PR. Nightly and stable images are built for both architectures.

## Version source

A version number is written down only where a human has already decided to publish, which is the **Release** dispatch. Nothing infers or guesses a future version anywhere else.

Aurral uses Semantic Versioning:

- Major (`3.0.0`): incompatible configuration, API, storage, or user workflow change.
- Minor (`2.1.0`): backward-compatible feature or integration.
- Patch (`2.0.1`): backward-compatible bug, security, dependency, or performance fix.

The **Release** workflow's version input is optional. Leave it blank and the workflow reads the Conventional Commit titles merged since the last stable tag and publishes the resulting version: major for any `!` marker, minor for any `feat`, otherwise patch. Enter a version to override the suggestion. Either way, no push ever publishes a release on its own.

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
4. CI validates the branch. In parallel, the preview workflow publishes a container built from the PR's merge commit, so the image is current `main` plus the change rather than the change on a stale base:

   ```bash
   docker pull ghcr.io/lklynet/aurral:pr-464
   ```

5. Test that image. The Preview workflow comments on the PR with the exact pull command and Compose test steps, and updates that comment when a new image is built. Push fixes to the branch, and each push replaces the preview image.
6. Give the PR a Conventional Commit title such as `feat: add playlist sharing` or `fix: prevent duplicate imports`.
7. Complete the PR checklist and test plan, including affected areas and manual steps, then use **Squash and merge**.
8. Delete the working branch. GitHub normally does this automatically.

Preview images are public, so testers can pull `:pr-<number>` without credentials. Keep a PR open when you want user feedback before the change reaches `main`. The image is deleted when the PR closes.

Several PRs can be in testing at once because each owns its own image, and nothing is force-pushed or held exclusively. Pull requests from forks are validated but publish no preview image, because they cannot access the registry credentials.

## Nightly

Every merge to `main` publishes `ghcr.io/lklynet/aurral:nightly` automatically. No action is required.

Nightly is the channel for anyone who wants merged work immediately, including you. It accumulates everything merged since the last release, so integration problems surface between releases rather than during one.

Nightly is also where user testing happens, and it is the last gate before a stable release.

After a successful nightly build, the workflow updates one status comment on each merged PR and each issue linked with a closing reference. The comment includes the nightly build identity, pull command, and links to the workflow and changes. It also applies the `nightly` label and removes `released`. A stable release updates the same comment with the released version, applies `released`, and removes `nightly` instead of adding another status comment.

## Release readiness

The first successful nightly after changes accumulate creates or updates the open **Release readiness: next stable** issue. It contains the current nightly build, source commit, change range, merged PRs, and linked closing issues. Keep test evidence in that issue, including the tester, date, exact nightly build, affected area, and result.

Complete the checklist in the issue and apply the `release-ready` label only when the current nightly candidate is ready to ship. The Release workflow requires both that label and a candidate built from the current `main` commit. Any newer source commit removes `release-ready`, so new changes must be tested before approval is restored.

After a successful stable release, the workflow records the release on the readiness issue and closes it. A later merge creates the next readiness issue. If a nightly notification fails, manually run **Actions → Nightly** on `main`; it rebuilds the current nightly and reconciles every change since the last stable release.

If stable-release comments fail after the release is published, run **Release** again with the already-published version, such as `2.1.0`, while `main` is still at the release commit. The existing-release path skips the image build and only finishes the release lifecycle. If `main` has advanced, run **Actions → Reconcile release notifications** with the published version instead; it pins reconciliation to the immutable release tag and never rebuilds or republishes the stable image.

## Fix a problem found on nightly

Merged work is fixed forward, not reopened. The merged PR is a single squashed commit on `main` and its branch is gone, which is expected.

Open a new branch from the current `main` and follow the normal change workflow with a `fix:` title. That base already contains the original change and everything else merged since the last release, so the preview image reproduces exactly what the reporter is running.

Repeat until nightly is clean, then release. The original change and its follow-up fixes ship as one stable version, and nobody on `latest` sees the intermediate states.

If a merged change turns out to be wrong rather than incomplete, revert it on `main`, release without it, and reland it later as a new PR.

## Publish a stable release

Merging a PR does not publish a release.

Release on a cadence rather than per merge. A minor release every two to four weeks is the target, and a patch release goes out as soon as a user-facing bug warrants it. Batching keeps release notes meaningful and keeps the update banner from firing at self-hosters for every merge.

1. Make sure that the intended code is on `main` and CI passed.
2. Open **Actions → Release → Run workflow**.
3. Select `main`. Leave the version blank to accept the suggested version, or enter one without `v`, for example `2.1.0`.
4. Watch the workflow through validation, version resolution, image publication, annotated tag creation, and GitHub Release publication. The resolution step logs the version it chose.
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

Create `hotfix/short-description` from `main`, use a `fix:` PR title, test the preview image, merge, and dispatch a new patch version without waiting for nightly to soak. Do not patch a published tag or container in place.

## Rollback

Redeploy the previous exact stable container, such as `ghcr.io/lklynet/aurral:2.0.0`. Do not move `latest` by hand and do not change an existing Git tag. Prepare a new patch release containing the correction.

## Tags

Every Git tag in this repository is a stable release. Retiring the `dev` and `test` branch channels removed their 376 `-dev.N` and `-test.N` tags and the 449 matching container versions, including the moving `:dev` and `:test` image tags, which now return a 404. The 211 release tags and their images are untouched.

Only `MAJOR.MINOR.PATCH` parses as a release, so a stray prerelease tag would be ignored rather than mistaken for one.
