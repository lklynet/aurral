# Aurral

Aurral is an all-in-one, self-hosted music app. It finds music you'll love, downloads it, manages your Library, and plays it: discovery and rotating flows, playlist imports from Spotify and YouTube Music, a built-in player, and a Subsonic API for other clients, with Lidarr and every other integration optional.

You can think of Aurral as a self-hosted Spotify that also replaces Lidarr.

## What makes Aurral special?

We have thousands of daily active users who love Aurral and it's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

Aurral is truly open. We share how we think about things, and of course we share all our code. A large number of users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop." We have not, and we're proud of the performance of Aurral. We regularly audit for performance regressions and scope-creep. Make sure all changes are considerate of performance impact.

### 3. Safe around real data

People connect Aurral to real libraries and services users run themselves. We make failures clear and verify service behavior before relying on it.

### 4. Aurral first

Aurral is the product. Every integration is an add-on a user may never connect, and none of them gets to make Aurral slower, flakier, or more complicated for everyone else. A small native feature that always works beats a deep integration that breaks when another app ships an update. Specialized integrations live in plugins that admins add themselves, so core stays minimal and reliable.

## A note from the maintainers

We like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni." Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of the document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", and more as "good defaults." The developer's preferences should be able to override anything here.

Of note: Most Aurral contributions will come from users running their own live Aurral. This means you should be careful about accessing data, killing dev servers, and other things that may damage the Aurral instance the contributor is running.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing Aurral.
- **we, us, and maintainers** means the people who maintain Aurral.
- **developer** means the person you are working with, a maintainer or an outside contributor.
- **user** means the person using Aurral to control their music library.
- **agent** means you.
- **environment** means one running Aurral server and the machine, filesystem, and state it owns.
- **data dir** means the directory holding an environment's `aurral.db`. A worktree's is its gitignored `backend/data`. A Docker install's is the folder mounted at `/config`.
- **live install** means a data dir a real Aurral is using, such as the developer's own.
- **native** means what Aurral does by itself, with nothing connected.
- **integration** means an optional external service Aurral talks to, such as Lidarr, Navidrome, Plex, slskd, or Last.fm. It is an add-on, never a dependency.
- **plugin** means a folder in `<data dir>/plugins/<id>` that an admin installs. Aurral calls it through typed capabilities, and it changes Aurral only through the public API.
- **eden** means the test lab in `eden/`. Each checkout runs its own with `pnpm eden dev`. See [Eden test lab](docs/src/content/docs/development/eden.mdx).

## The five ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and the machine may run other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to a live install.** The developer's own Aurral is in use while you work. Reading it is fine. Never start a server against one, never open its database read-write, and never point `AURRAL_DATA_DIR` or `AURRAL_DB_PATH` at one. Never copy a data dir: a copy carries working credentials for every integration, so it acts on the user's real services. Use Eden, which builds its own.
3. **Baking in origins.** Never set `VITE_API_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, and `/sso/callback` to the backend. Setting it bakes localhost into the bundle and silently breaks every remote browser.
4. **Letting perf slip.** `.tests/perf/baseline.json` records each measured page's queries, response bytes, full table scans, and outbound calls, and `pnpm test` fails when any drifts. The Perf check on each PR compares timing and memory against `main`. Fix the cause instead of refreshing the numbers. Run `pnpm run perf:baseline` only for an intended change, and say in the PR what moved and why. Never add the `perf-accepted` label; that is a maintainer's call. A new page or endpoint that reads the Library or calls out gets a scenario in `.tests/perf/scenarios.ts`.
5. **Hammering brainzmash.** Every Aurral install shares the free brainzmash relay (`lidarrapi.brainzmash.cc`) and MusicBrainz. If we overload them, they block Aurral for everyone, so call them only when needed:
   - Go through `backend/services/providers/brainzmashProvider.ts` and `backend/services/apiClients/musicbrainzHttp.ts`. They cache, share in-flight requests, pace requests, and back off on errors and outages. Never call either service another way.
   - Fetch for what the user is looking at. No prefetching, cache warming, or loops over a Library's artists or albums. Background work calls out for what changed, never in proportion to Library size.
   - A warm page load makes zero brainzmash calls. The perf baseline counts them per scenario, and any increase needs a maintainer's sign-off.
   - Test against Eden. `pnpm eden dev` serves metadata from a recorded catalogue and never calls brainzmash. `pnpm run dev` uses the public relay, so keep it to a quick look. Never script bulk lookups against the relay or clear the metadata cache to test; fake the service in a test.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Entry points.** An action on one page is usually also reachable from artist, album, and track menus, global search, the player, and Settings. Fixing one is not fixing the feature.
- **Clients.** The browser app at desktop and mobile widths, Aurral apps on the JSON API, and Subsonic clients on `/rest`. The [app API contract](docs/src/content/docs/api/app-contract.mdx) is versioned: add a feature flag instead of changing a response apps already read.
- **Integrations.** Finish the native path with nothing connected first. Then decide per affected service, including when it is not configured, unreachable, or failing. Often the right decision is to leave a service alone. See [Integrations](#integrations).
- **Plugins.** Plugins add menu actions on playlists, flows, albums, artists, and tracks, and receive events like `playlist.changed`, `track.played`, and `download.finished`. A new menu or a change to what an event means needs a decision for plugins. Changing a capability's input or output breaks plugins: add a field, or raise `PLUGIN_API_VERSION` and keep reading the old version. Safe mode tells a plugin bug from an Aurral bug. See [ADR 0010](docs/architecture/0010-plugins.md).
- **Background work.** Flows, downloads, and scheduled tasks run in separate worker processes. Logic they share with routes belongs in a service, not route handler code.
- **Persistence.** Stored settings, migrations from older data, defaults for new installs, and cleanup. Check `docs/architecture/` before renaming a stored or public name.
- **Users and auth.** An admin and a regular user see different things. Local accounts, OIDC, and proxy auth all reach the same features.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Close needs reopen. A one-way door is a bug.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Integrations

- **Native first.** Every feature works completely with nothing connected. Build and polish the native path first. An integration is never required to finish a feature.
- **Publish, don't drive.** Prefer outputs other apps pick up on their own over syncing through their APIs: playlist files in the Library folder, `cover.jpg` beside the tracks, the Subsonic API. That is why Aurral writes M3U files instead of maintaining playlists in Navidrome, Plex, and Jellyfin (#1492).
- **Thin when you must call out.** When a service can't read what Aurral publishes, use the smallest call that hands it over, like Plex's playlist upload (#1509). No per-service track matching, ID mapping, or sync state to keep in step.
- **Contained.** An integration never blocks, slows, or breaks native behavior. Its client stays at the service boundary, its settings and errors show on its own page, and a failure is clear and recoverable. Don't add per-service special cases to core code.
- **Earn the cost.** Before adding an integration or growing one, ask whether most users need it and whether we can keep it working. If not, it belongs in a [plugin](docs/architecture/0010-plugins.md). Replacing a brittle integration with a native mechanism, or removing it, is a valid fix.

## Dev servers

- `pnpm eden dev` starts Aurral against this checkout's Eden: a seeded Library, listening history, and stand-ins for the catalogue and every outside API. Add `--with <service>` or `--all` for the services a task touches. `pnpm eden status` prints the addresses and logins.
- `pnpm run dev` starts the backend and frontend with an empty database in `backend/data`. Use it for onboarding and first run. It takes ports 3001 and 3009, or the next free ones, and prints its address.
- Eden's state lives in `.eden/`. `pnpm eden down` removes it, and the next `up` is a fresh start. Run `down` before deleting a worktree.
- The backend starts background workers as separate processes. Start servers with `setsid` and stop the whole group with `kill -- -<pgid>`, using the group from `ps -o pgid= <pid>`. See rule 1.
- Need a second checkout? `git worktree add` it next to this one, not in `/tmp`. Remove it when done.

## Test data

| The task touches                                     | Setup                                 |
| ---------------------------------------------------- | ------------------------------------- |
| Backend logic or UI pieces                           | None: tests                           |
| Onboarding and first run                             | `pnpm run dev` and its empty database |
| The Library, playlists, flows, history, or discovery | `pnpm eden dev`                       |
| Downloads or an integration                          | `pnpm eden dev --with <service>`      |
| A whole feature across services                      | `pnpm eden test`, or a new journey    |

- Every Aurral test account is `test` / `password`, including the onboarding admin. Eden also has `listener` / `password`, a regular user.
- Create what your test needs through the app or its API, and only in your own Eden.
- Eden's catalogue is a fixed set of artists. An artist outside it is not found, so pick test music from `eden/catalogue/artists.ts`.
- Eden doesn't cover everything. `pnpm eden status` lists what it leaves out.
- [test-in-eden](.agents/skills/test-in-eden/SKILL.md) shows how to pick services, find test music, and check what Aurral did.

## Verifying

- Before you push, run `pnpm run check`. It runs format, lint, UI lint, the `rows.ts` freshness check, typecheck, and the unsafe-`any` ratchet against `lint-any-baseline.json`. Then run `pnpm test`, plus `pnpm run test:integration` for integration behavior, `pnpm run build` for frontend build changes, and `pnpm run docs:build` for docs. For changes to downloads, integrations, plugins, or sign-in, run `pnpm eden test`, which runs the end-to-end journeys against a new Eden with every service.
- While you iterate, run `pnpm exec vp test run <files>`, adding `-t "<name>"` for big files, and `pnpm run typecheck`.
- The pre-commit hook runs `vp check --fix` on staged files and adds its fixes to the commit. It also blocks commits to `main`, so commit on a branch. Do not skip it with `--no-verify`.
- Backend behavior changes ship with focused tests for that behavior.
- Test behavior that can break, such as the download pipeline and file matching, integration response parsing, auth and permission guards, persistence and migrations, race fixes, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, mock-call mirrors, callback wiring, and props rendered to static markup.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test or at each call site.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first, in an existing case of the module's test file where one fits, then the fix. Purely visual bugs (spacing, color, alignment, a layout shift) get before/after captures and no test.
- Unit tests are `.tests/**/*.test.ts` and integration tests `*.int.test.ts`.
- Use real SQLite and temp directories from `.tests/helpers/backendTestHarness.ts`. `.tests/setup-env.ts` gives each run its own data dir and rejects requests to external hosts, so fake the service instead (see `.tests/helpers/fakeNavidrome.ts`).
- Never wait on sleeps, polling, or elapsed wall-clock time. Use `.tests/helpers/fakeClock.ts`, or await the event or promise that marks the milestone. A test that needs a timeout to pass is wrong. Journeys in `eden/journeys` are the one exception: they wait on real services, so they poll until a deadline.
- User-visible frontend changes get one integrated pass in a real browser, at desktop and mobile widths when layout changed. The primary agent does this once after integrating. Subagents do not launch their own dev servers.
- CI is the merge check. A local Eden run adds evidence.

## Pull requests

- Never make a PR unless the developer explicitly asks you to.
- Conventional commit titles in plain language, scope optional: `fix(playlists): keep Library files a playlist reused when it is deleted`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work, such as `Created with <model> in <harness>.` Include any subagent models that wrote part of the change. Use the names your harness reports, and name only the harness if it reports no model.
- Start every comment you post for the developer with the note below, so readers know an agent wrote it. That covers PR comments, review comments, replies to reviewers and bots, and reasons for dismissing a finding. It does not go in PR descriptions or commit messages.

  ```md
  > [!NOTE]
  > 🤖 **<model> responding on behalf of <developer>**

  The comment starts here.
  ```

- Rebase onto the latest `main` before opening. Open a real PR, not a draft.
- UI changes need before/after images. Motion or timing needs a short video. Upload evidence to GitHub; never commit PR-only screenshots.
- One request is one PR. Split it only when asked. Outside contributions follow [CONTRIBUTING.md](CONTRIBUTING.md).
- When babysitting: if your harness can watch a PR, use that and end your turn. Do not poll or sleep. Verify each bot finding against the source, fix real ones, and dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Documentation

Most code changes do not need a documentation change. Agents can read the code.

- `docs/architecture/` holds numbered decision records: decisions and their reasons, constraints that span components, and traps that are hard to see from the source. Before adding one, ask what a maintainer would get wrong without it.
- Do not document every feature, enumerate fields, narrate control flow, or append PR summaries. When a documented decision changes, rewrite or remove the affected text instead of appending.
- User docs live in `docs/src/content/docs/`. Give each major feature a concise section on what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, layouts, or every UI state are not. A UI tweak does not need a docs entry.
- Keep user docs in the product's voice, without implementation details. Contributor conventions belong in `CONTRIBUTING.md` and `docs/src/content/docs/development/`.

## Plans and work artifacts

- Put plans, research notes, throwaway scripts, logs, and other scratch files in this worktree's `.scratch/`, not `/tmp` or elsewhere outside the worktree. Git ignores it, and it goes away with the worktree. Never commit its contents.
- Track active work in the GitHub issue that owns it. A merged PR is the implementation record; close or update its issue when the work lands.

## How it works

The backend (`backend/server.ts`) is Hono on Node with one SQLite database, `aurral.db`, in the data dir. Node runs the TypeScript directly, so the backend has no build step, in dev or in the Docker image. Each feature in `backend/routes/` is a Hono app that sets its own `basePath`, so its middleware stays on its own routes, and `backend/routes/api.ts` mounts it. Routes stay thin and call services in `backend/services/`. Audio and file responses skip Hono's response handling and write straight to the Node response through `sendViaNode`. Durable work (downloads, flows, playlist syncs, scheduled tasks) runs through Aurral's own job queue in `backend/services/jobs/` (tables `jobs`, `job_locks`, and `job_schedules`; see [ADR 0012](docs/architecture/0012-job-queue.md)), and isolated worker groups run as child processes under `backgroundProcessSupervisor.ts`. Live updates reach the browser over `/ws`. Each integration has a client at the service boundary. The frontend is React with React Query and React Router, built by Vite+, and also installs as a PWA. Vite+ (`vp`) also owns formatting, linting, and tests, configured in the root `vite.config.ts`.

## Where code lives

- `backend/`: behavior, persistence (`backend/config/db-sqlite.ts`, `backend/db/`), and integrations. `backend/db/rows.ts` has one generated row type per table.
- `lib/`: code shared by the backend and frontend.
- `frontend/`: the browser app. Theme tokens live in `frontend/src/index.css`; `frontend/lint-rules/` and `frontend/scripts/lint-ui-css.mts` enforce them. `frontend/public` and `frontend/lint-rules` stay JavaScript because browsers and oxlint load them as-is.
- `web/`: the aurral.org site and its share-link functions, in JavaScript.
- `backend/services/plugins/`: the plugin host. `plugin-api.md` and `aurral-plugin.d.ts` beside it are the plugin API reference, and the docs site and `/api/mcp` both read them.
- `.tests/`: unit and integration tests.
- `docs/`: the documentation site and `docs/architecture/` decision records.

## TypeScript

- Use only type syntax Node can strip: no `enum`, `namespace`, or constructor parameter properties. In code Node runs (`backend/`, `lib/`, tests), relative imports carry their `.ts` extension. Lint enforces both.
- `any` is the enemy, and lint rejects it along with every `@ts-` comment. Narrow `unknown` instead of casting.
- Inferred types over annotations. Each shape has one owner: queries use the row types in `backend/db/rows.ts`, as in `db.prepare<[number], UsersRow>("SELECT * FROM users WHERE id = ?")`, and API shapes belong to their route. Routes declare input with Valibot through `validate()`, and the frontend calls each feature through its own `hc` client in `frontend/src/utils/api/clients/`, such as `inboxClient`, which infers both sides. One client per feature keeps the editor fast; don't build one client for the whole API.
- After a schema change, run `pnpm run db:types` to regenerate `rows.ts`. Never edit it by hand.

## Taste

- Read the [design bible](docs/src/content/docs/development/ui-design-system.mdx) before any UI change. It is the single source for how Aurral looks and behaves. Match it instead of inventing, and update it when a pattern changes. `pnpm run lint:ui` enforces the tokens; the rest is on you.
- Keep core behavior direct and testable.
- Warnings and errors mean an admin should act. Expected outcomes, like a rejected candidate, a search reaching its own deadline, or a request the client abandoned, log at info.
- React effects are for synchronizing with something outside React. Derive in render and act in handlers instead of syncing state, but don't hide real lifecycle work in refs or stores to dodge one.
- No comments unless they explain a workaround or an invariant the code can't show.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
