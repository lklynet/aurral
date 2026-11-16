# Accounts and the hub

Status: Accepted

## Problem

Community features, like public playlists, friends, and what a friend is playing, need somewhere shared that every server can reach, including servers behind NAT with no address of their own. aurral.org already stores anonymous shares in D1 through Pages Functions, but it has no idea of a person, and its endpoints are untyped JavaScript with schemas created on first use.

## Decision

aurral.org gets accounts and a hub: a TypeScript Hono app on Cloudflare Workers in `hub/`. Servers push small JSON payloads to it and read their friends' back. No server ever connects to another.

- **The hub is part of aurral.org.** A Worker route serves `aurral.org/v1/*`, and Worker routes win over the Pages project on the same hostname, so `AURRAL_SHARE_ORIGIN` stays the one origin a fork sets. Every link stores the origin it was made with, and changing the variable never sends a token to a different hub.
- **One database.** The hub binds the same D1 database as the Pages Functions, because linking authenticates a server with the instance secret in `instances`. Its migrations in `hub/migrations` own the schema from now on.
- **A versioned API.** Routes live under `/v1` and only change additively, because released servers and forks call the hub deployed from `main`. Aurral gets types from `hc<typeof hub>` and still validates every response with Valibot, per [0007](./0007-validating-integration-data.md).
- **Accounts.** better-auth on D1 with Discord and GitHub sign-in, and no email sign-in. Accounts never merge by email. Every hub table keys on the account's immutable ID. Handles are for display and lookup only.
- **Linking.** A server user links to an account with a device code. The server starts the request with its instance secret, the local user ID, and the server name. The user approves at `aurral.org/link`, on a page that names the server and the local user. The hub then issues an opaque token for that link and stores only its hash. One account can link users on many servers, each with its own token.
- **What a link token can do.** Publish for that link, and read what the account's friends share. It can't rename the handle, delete the account, touch other links, or send or accept friend requests. Those happen only on aurral.org.
- **The trust runs one way.** Linking gives aurral.org no access to the server. The server's admin can act as every linked account through its tokens, so "friends only" means your friends and the admins of their servers. The approval page and the privacy policy say so.
- **Every way in has a way out.** Unlinking on either side revokes the token. Deleting an account revokes every link and removes everything it published. Deleting a local user drops its token.

## What aurral.org stores

- Accounts: the OAuth identity, the handle, and the account's links.
- Anything a user publishes: public playlists, now playing, and bounded summaries such as top plays over the last 30 days.
- Friendships.

It never stores a listening history, a Library, files, or anything a server didn't send on a user's behalf. Now playing is one entry per link that expires after the track ends.

## Traps

- Until the share endpoints move into the hub, the Pages Functions in `web/functions` still create `instances` and `shares` on demand, and the first migration creates the same tables with `IF NOT EXISTS`. Change both together. `.tests/hub/migrations.test.ts` fails when they differ.
- Instance IDs are self-issued, so anything counted per instance can be forged with a loop. Count linked accounts instead.
- A restored backup gives two servers the same instance and link tokens, and both keep working as the same link until one relinks.
- `hub/src` imports `D1Database` from `@cloudflare/workers-types/index.ts` instead of the ambient types. The ambient ones clash with the DOM and Node types in the root typecheck, which also checks the hub, and Aurral's `hc<typeof hub>` would pull them in.

## Alternatives

- **Clerk.** Hosted and quick, but another vendor holding every identity, billed per user, for a project that is open at the core.
- **Federation between servers.** No central service, but every server would need a public address, which most don't have.
- **Extending the Pages Functions.** Already deployed, but untyped JavaScript with no migrations and no tests, and accounts would make it the most sensitive code the project runs.
