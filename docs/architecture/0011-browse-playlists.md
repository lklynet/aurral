# Browse playlists are track lists

Status: Accepted

## Problem

Streaming apps make most of their listening happen through playlists. Aurral's own playlists were flows, and a flow sends every track through the download pipeline. That is too slow and heavy to give every user a dozen fresh playlists a day.

## Decision

A browse playlist is a list of tracks Aurral shows and plays. Nothing downloads until the user saves it.

- **Providers.** Every browse playlist has a provider from `lib/browsePlaylists.ts`: `deezer` for editor playlists, `mix` for mixes, and `discovery` for Made for you. The detail page, the routes under `/api/discover/playlists/:provider/:id`, search results, and query keys all take the provider and id. A new source is a new provider, not a new page.
- **Mixes are computed, never stored.** `services/discovery/mixes.ts` builds them from `play_events` and the Library, using randomness seeded by user, day, and mix id. The only network call is the similar-artist lookup for radio mixes, which radio caps at 2.5 seconds per artist. If it fails, the mix still builds from the Library. The random picks stay the same all day, so a mix only changes within a day when new plays change its inputs. The 30 minute cache only saves work.
- **Made for you is stored.** It needs Deezer, so `services/discovery/discoveryPlaylists.ts` builds it at the end of each discovery refresh and keeps it in `discovery_playlists`. A playlist whose lookups all fail keeps its previous row.
- **Covers are drawn, not picked.** Mixes and Made for you use the playlist cover templates with the lead artist's photo, one template per kind (`services/discovery/browseCovers.ts`). The cover URL carries a hash of the title, template, and artist, and the file is cached on disk under that hash, so a cover only redraws when one of them changes. Without a photo the template draws the title on color.
- **Owned tracks play in full.** Every browse playlist response gives each track `owned` when it matches a Library track. The player streams that file and records history. Other tracks play the Deezer preview and record nothing.
- **Saving is one import path.** Saving any browse playlist creates a synced import: `BROWSE_IMPORT_PROVIDERS` in `lib/browsePlaylists.ts` maps each provider to its import source, and the browse id is the external id. Each sync reads the source's latest version, the same as any other import, so a saved mix or Made for you playlist follows its rebuilds.
- **Only saved copies leave the app.** Browse playlists are per-user and change daily, so Subsonic and other clients see a mix or Made for you playlist only once the user saves it.

## Traps

- Mix ids like `daily-1` and `artist-<id>` name a slot, not a fixed set of tracks. A link to one opens today's version, and a saved copy syncs to whatever fills the slot. Slots empty and refill, so these import lists are `rotating`: while a slot is empty, sync keeps the saved tracks and records no error.
