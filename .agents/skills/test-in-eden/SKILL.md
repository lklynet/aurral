---
name: test-in-eden
description: Test an Aurral change against Eden, the test lab in this repo. Use when a change needs a real Library, listening history, downloads, an integration, a plugin, or sign-in to verify, or when writing an end-to-end journey.
---

# Test in Eden

Eden gives this checkout its own Aurral with a seeded Library and working
copies of the services Aurral connects to. Read
[Eden test lab](../../../docs/src/content/docs/development/eden.mdx) for what
it contains. This skill covers how to use it for a change.

## Start it

Run `pnpm eden status` first. If this checkout's Eden is already up, reuse it.

Otherwise start `pnpm eden dev` with the services the change touches:

| The change touches                                        | Add                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| The Library, playlists, flows, history, discovery, search | nothing                                                                     |
| A download source                                         | `--with` that source: `nzbget`, `sabnzbd`, `qbittorrent`, `slskd`, `lidarr` |
| Plugins or plugin events                                  | `--with plugins`                                                            |
| Notifications                                             | `--with gotify,webhooks`                                                    |
| Media servers and history servers                         | `--with navidrome,jellyfin,koito`                                           |
| OIDC or proxy sign-in                                     | `--with sso`                                                                |
| Subsonic clients                                          | `--with feishin,airsonic`                                                   |

`pnpm eden status` prints every address and login. The ports are in
`.eden/ports.json` and differ per checkout, so never hardcode one.

`pnpm eden dev` stays in the foreground, so start it in its own session. To
stop it and keep the lab, signal the PID in `.eden/dev.pid`. `pnpm eden down`
stops it too, then removes the lab. Never stop a process you found by name.

## Pick test music

- `.eden/library` holds what the Library already has. Every seventh album is
  missing its last tracks.
- `.eden/world/manifest.json` lists the albums a download can find. Request
  one of these to test a download that succeeds.
- A catalogue album in neither place is known to Aurral but has no source.
  Request one to test a download that fails.
- An artist outside `eden/catalogue/artists.ts` is not found at all.
- One artist in sixteen, Thom Yorke and Slowdive among them, put out its
  least-known release in the last few weeks. Use one to test new releases.

The files are silent FLAC with the right lengths and tags. They prove matching,
tagging, and import. They prove nothing about audio.

## Prove one path

With several download sources on, Aurral picks one. To prove a specific
source, turn the others off first: set `enabled` on each integration through
`POST /api/settings`, and on each plugin through `PUT /api/plugins/<id>`.
`eden/journeys/downloads.eden.test.ts` does this.

slskd runs one search at a time and each runs to its timeout, so Soulseek
downloads take longer than the others. Wait on the job, not on a fixed time.

## Check what Aurral did

- **Calls to outside APIs.** The outside proxy lists every request at
  `/requests` on its address, with host, path, and body. This is how to check
  that a scrobble or a lookup was sent.
- **Notifications.** The webhook receiver lists what it got at `/requests`.
  Gotify shows messages in its web page and at `/message`.
- **Plugin calls.** The `eden-fixture` plugin appends each call to
  `.eden/aurral/plugin-data/eden-fixture/calls.jsonl`.
- **Aurral's own record.** Read `.eden/aurral/aurral.db` read-only, and
  `.eden/aurral/logs/aurral.log`. A warning or error there during your test
  needs an explanation.

For anything a user sees, also open the app in a browser at desktop and mobile
widths.

## Start over

`pnpm eden down` stops Aurral and removes the lab and everything it wrote. The next `up` is the
same fresh start. Do this when a test left state you can't account for. Don't
edit files in `.eden/` by hand.

## Add a journey

A change to downloads, an integration, a plugin, or sign-in gets a journey when
no existing one would fail without it. Journeys live in `eden/journeys` as
`*.eden.test.ts`.

- Import `api`, `ports`, `has`, `until`, and `worldRelease` from
  `eden/journeys/eden.ts`.
- Skip with `test.skipIf(!has("<service>"))` so the journey runs only when its
  services are up.
- Take a `worldRelease` index no other journey uses, so two journeys never
  download the same album.
- Wait with `until`, and assert on what Aurral recorded.

Iterate against a running `pnpm eden dev --all` with
`pnpm exec vp test run --project eden <file>`. Before pushing, run
`pnpm eden test`, which rebuilds the lab with every service and runs them all.

## Grow Eden when it falls short

Eden should keep growing until it can test everything Aurral does. When a test
needs something Eden doesn't do, such as a field Aurral reads that a stand-in
leaves out, an ID that doesn't line up, or data no seeded artist has, fix Eden in
the same change. Don't fake responses in the browser or skip the check.

- Build the answer from the catalogue in `eden/outside` or `eden/metadata`, so
  every lab gives the same one.
- Add an assertion to `.tests/eden/eden.test.ts` that fails without the fix.
- Say in the PR what Eden gained.

`pnpm eden status` ends with what Eden leaves out, from `eden/coverage.ts`.
When a gap can't be filled without a real account or service, add it there with
the reason, and in the PR describe what you checked instead. Never point Eden
at a real account or a real service to fill the gap.
