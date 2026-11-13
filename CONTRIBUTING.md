# Contributing

Aurral welcomes contributions. We review every change against the project's direction, maintenance cost, and the size of the change.

Opening a pull request does not guarantee a review or a merge. We may close it, ask you to split it, defer it, or implement the idea in a different way.

## Aurral's direction

Aurral is opinionated. It is for people who want an easy, reliable way to get music and play it in a modern, Spotify-like app. It does not compete with Lidarr. Power users who want control over every release, profile, and setting already have Lidarr, and it serves them well.

So we choose one good default over a new setting, and a feature needs a better reason than "Lidarr has it."

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
- New settings where one good default would do.
- Features whose main case is matching Lidarr.
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

## Use an AI agent

Agents are welcome. [AGENTS.md](AGENTS.md) holds the rules an agent follows in this repo, and most agents read it on their own. `.agents/skills/` holds skills for work specific to Aurral, such as testing in Eden.

- Say what did the work. End the pull request description with the model and harness, and have the agent mark the comments it writes, as AGENTS.md describes. Reviewers want to know what they are reading. It is not held against you.
- You answer for what you submit. Read the diff, run it, and be ready to explain it.
- A change gets the same review whether a person or an agent wrote it.

## Screenshots

Store app screenshots in `web/screenshots/`. The README, docs, and marketing site share these files. Replace the file there to update all three.

## Run the checks

Use Node.js from `.nvmrc` and pnpm from `packageManager` in `package.json`. Run `pnpm install --frozen-lockfile` at the repository root to install the app and docs dependencies. If you use the global Vite+ CLI, `vp install --frozen-lockfile` selects the pinned pnpm version.

Aurral uses [Vite+](https://viteplus.dev) for formatting, linting, tests, and frontend builds. Run these from the repository root:

```sh
pnpm run check             # formatting, lint, UI style, and type checks
pnpm test                  # unit tests
pnpm run test:integration  # integration tests
pnpm run build             # frontend build
```

Aurral is written in TypeScript and Node runs the `.ts` files directly, so use only type syntax that Node can strip: no `enum`, `namespace`, or constructor parameter properties. In code that Node runs, such as `backend/`, `lib/`, and the tests, write relative imports with their `.ts` extension.

Type checking is strict, including `noUncheckedIndexedAccess`, so `record[key]` and `array[i]` can be `undefined`. Handle the missing case, and prefer a `Map` or a union-keyed record over narrowing each read. Any type error fails `pnpm run check`.

An `any` that reaches code without a type error, such as a `JSON.parse` result, goes just as unchecked. `lint-any-baseline.json` counts the `no-unsafe-*` lint findings in each TypeScript file, and `pnpm run check` fails when a file has more. Type the value as `unknown` and narrow it instead. Run `pnpm run lint:any --update` after you clear some. Never raise the baseline.

To try a change against real services, run `pnpm eden dev`. It starts Aurral with a seeded Library and local copies of the services it connects to, and `pnpm eden test` runs the end-to-end journeys against them. See the [Eden test lab](https://docs.aurral.org/development/eden/).

`.tests/perf/baseline.json` records the SQL queries, response size, full table scans, and outbound metadata calls of common page loads and Subsonic calls against a synthetic Library. Tests never reach the real metadata services: brainzmash and ListenBrainz are local fakes, and other hosts are blocked and counted. `pnpm test` fails when queries, size, or scans drift more than 5% either way, or when any call count changes. If the change is intended, run `pnpm run perf:baseline` and commit the file so the change shows in review. Pull requests also run the Perf workflow, which times the same page loads, server startup, and the initial frontend bundle on main and on the pull request in one job, and posts the results as a comment. It fails when a measurement is clearly slower. To compare locally, build the frontend in both checkouts and run `pnpm run perf compare <path to a main checkout>`. To accept an intended slowdown, a maintainer adds the `perf-accepted` label and re-runs the job.

`backend/db/rows.ts` holds one row type per SQLite table, generated from the schema. Run `pnpm run db:types` after a schema change, and type queries with them, for example `db.prepare<[number], UsersRow>("SELECT * FROM users WHERE id = ?")`.

Run `pnpm run format` to format the whole repository. After `pnpm install`, the pre-commit hook formats and lints the files you stage. It adds its fixes to the commit and stops the commit when a lint error remains.
