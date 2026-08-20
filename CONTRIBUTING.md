# Contributing

Aurral welcomes contributions. We review every change against the project's direction, maintenance cost, and the size of the change.

Opening a pull request does not guarantee a review or a merge. We may close it, ask you to split it, defer it, or implement the idea in a different way.

## Start with the right place

Search existing issues and pull requests before starting work.

For a bug, open a focused bug report when no existing issue covers it. Include steps that let someone reproduce the problem.

For a feature, choose one of these paths before writing code:

- Open a feature request issue and wait for approval.
- Join the [Aurral Discord](https://discord.gg/cpPYfgVURJ) to discuss the idea with developers and testers.

An issue or Discord conversation is not approval by itself. Start implementation after a maintainer agrees that the change fits Aurral.

## GitHub labels

Aurral keeps human triage labels small:

- `bug` marks broken behavior.
- `enhancement` marks a requested improvement or new capability.
- `documentation` marks documentation work.
- `needs-triage` marks an issue that still needs maintainer review.

Pull requests receive one automatic `size:*` label based on changed lines. Release and nightly labels are maintained by automation.

## Changes we can review

We are most likely to accept:

- Small, focused bug fixes.
- Reliability and performance fixes.
- Tests, documentation, and focused maintenance.
- A feature that has been discussed and approved before implementation.

Keep each pull request about one problem or one closely related change. If you have several ideas, use separate issues and pull requests.

## Changes we will usually return

We are unlikely to accept:

- Several new features bundled into one pull request.
- Unapproved feature work.
- Large rewrites or opinionated refactors.
- Drive-by formatting or unrelated cleanup.
- New dependencies without a clear need.

Large changes are not automatically wrong, but they need a clear reason and a narrow scope. A 4,000-line pull request that adds several features will be closed or returned for splitting.

## Open a pull request

- Use a [Conventional Commit](https://www.conventionalcommits.org/) title such as `fix: handle missing Lidarr albums`, `feat: add playlist filtering`, or `docs: clarify Docker storage`.
- Explain what changed and why it belongs in Aurral.
- Link the related issue when one exists.
- Keep unrelated fixes, refactors, formatting changes, and dependency updates out of the pull request.
- Add tests for changed behavior when the existing test setup covers it.
- Include before-and-after screenshots for UI changes.

Keep UI changes focused and explain any new interaction in the pull request.

Before opening the pull request, run the checks that apply to your change and describe any manual testing in the pull request. Maintainers may ask for a smaller diff, more context, or a separate pull request.
