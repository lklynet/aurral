# Aurral release guide

This document is the maintainer procedure for developing, testing, and releasing Aurral.

## Branch roles

| Branch | Purpose |
| --- | --- |
| `main` | Protected stable source. Every published stable version comes from this branch. |
| `feat/*`, `fix/*`, `hotfix/*`, `docs/*`, `ci/*`, `chore/*`, `refactor/*` | Temporary working branches created from `main`. |
| `dev` | Disposable pointer used to build the internal development container. |
| `test` | Disposable pointer used to build the user-testing container. |

Feature branches contain the work. `dev` and `test` contain no unique work and are never merged into another branch.

## Version source

The version entered into the manually dispatched **Stable Release** workflow is the single Aurral product version. `package.json` is package metadata, not a release decision.

Aurral uses Semantic Versioning:

- Major (`3.0.0`): incompatible configuration, API, storage, or user workflow change.
- Minor (`2.1.0`): backward-compatible feature or integration.
- Patch (`2.0.1`): backward-compatible bug, security, dependency, or performance fix.
- No release: documentation, CI, tests, or internal refactoring with no shipped behavior change.

Contributors do not change product versions. The maintainer selects the version when publishing the tested code on `main`.

## Normal change workflow

1. Synchronize `main` and create a short-lived branch:

   ```bash
   git fetch origin --prune
   git switch main
   git pull --ff-only origin main
   git switch -c feat/short-description
   ```

2. Implement and validate the change.
3. Push the working branch to `origin`.
4. Open a draft PR against `main`.
5. Deploy the exact remote branch commit to development:

   ```bash
   ./scripts/deploy-channel.sh dev feat/short-description
   ```

6. After development testing passes, promote that same commit to user testing:

   ```bash
   ./scripts/deploy-channel.sh test feat/short-description
   ```

7. If testing finds a problem, fix the working branch and repeat both deployments. The script promotes only commits that `dev` points to.
8. Give the PR a Conventional Commit title such as `feat: add playlist sharing` or `fix: prevent duplicate imports`.
9. Complete the PR checklist and use **Squash and merge**.
10. Delete the working branch. GitHub normally does this automatically.

Each deliberate deployment creates an immutable prerelease tag and container plus a moving channel container:

```text
v2.1.0-dev.1   ghcr.io/lklynet/aurral:2.1.0-dev.1   ghcr.io/lklynet/aurral:dev
v2.1.0-test.1  ghcr.io/lklynet/aurral:2.1.0-test.1  ghcr.io/lklynet/aurral:test
```

These tags drive the update banner for each prerelease channel. They are not GitHub Releases.

## Publish a stable release

Merging a PR does not publish a release.

1. Make sure that the intended code is on `main` and CI passed.
2. Select a new SemVer version based on the largest included user-facing change, and make sure you did not publish it before.
3. Open **Actions → Stable Release → Run workflow**.
4. Select `main` and enter the new version without `v`, for example `2.1.0`.
5. Watch the workflow through validation, image publication, annotated tag creation, and GitHub Release publication.
6. Make sure that the exact version and moving aliases exist:

   ```text
   ghcr.io/lklynet/aurral:2.1.0
   ghcr.io/lklynet/aurral:2.1
   ghcr.io/lklynet/aurral:2
   ghcr.io/lklynet/aurral:latest
   ```

If `release-notes/<version>.md` exists, the workflow uses it as curated release notes. Otherwise GitHub generates notes from merged PRs and `.github/release.yml`.

Stable tags are permanent. Never move, reuse, or delete a published stable tag. Correct a bad release with a new patch version.

## Hotfixes

Create `hotfix/short-description` from `main`, use a `fix:` PR title, and follow the same dev → test → PR → manual release flow with a new patch version. Do not patch a published tag or container in place.

## Rollback

Redeploy the previous exact stable container, such as `ghcr.io/lklynet/aurral:2.0.0`. Do not move `latest` by hand and do not change an existing Git tag. Prepare a new patch release containing the correction.
