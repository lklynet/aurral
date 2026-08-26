# Better Auth migration

## Decision

Aurral uses Better Auth for local credentials, sessions, bearer tokens, OIDC provider transactions, and account administration. The application keeps a thin adapter for behavior that belongs to Aurral's protocols or deployment boundary.

Better Auth owns these SQLite tables:

- `users`
- `sessions`
- `accounts`
- `verifications`

Aurral keeps application permissions, listening-history settings, Lidarr preferences, discovery layout, and other user-scoped data in its existing application tables. Existing numeric user IDs remain stable because application tables reference them.

## Request flow

The Express server mounts Better Auth under `/api/auth/*`. The frontend uses the Better Auth endpoints for email sign-in, session lookup, sign-out, password changes, OIDC sign-in, and administrator user management.

The auth adapter resolves a Better Auth session into Aurral's request user shape. Permission middleware and route handlers continue to consume that shape. The adapter also handles trusted reverse-proxy identity, LAN auto-login, the instance API key, Subsonic authentication, media tokens, and WebSocket query tokens.

Better Auth bearer tokens use the `Authorization` header for HTTP requests. Aurral's WebSocket adapter accepts the same session token as `/ws?token=SESSION_TOKEN` because the browser supplies the token during the WebSocket handshake. Media routes keep their short-lived query-token flow.

## OIDC

Better Auth starts the OIDC provider flow with `POST /api/auth/sign-in/social` and completes it at `/api/auth/callback/oidc`. Better Auth owns state, nonce, PKCE, provider account linking, and session creation. Aurral maps the provider profile to its application role and compatibility username data.

Do not add a second callback or session exchange layer around Better Auth.

## Migration

The database migration creates the Better Auth tables and copies existing local users into Better Auth user and credential-account records. It preserves numeric IDs, password hashes, roles, permissions, and application foreign keys. Existing custom sessions are not copied. Users sign in again after the migration.

`BETTER_AUTH_SECRET` must remain stable across restarts and upgrades. Operators must back up `/config` and the matching environment or secret store before migration. A rollback requires restoring the pre-migration database and configuration together. The previous application version must not open a migrated database.

## Ownership boundary

| Concern | Owner |
| --- | --- |
| Email/password credentials | Better Auth |
| Browser and bearer sessions | Better Auth |
| OIDC state, PKCE, callback, and provider account | Better Auth |
| User administration endpoints | Better Auth, with Aurral permission data |
| Aurral roles and feature permissions | Aurral adapter and permission checks |
| Trusted proxy headers and source IPs | Aurral adapter |
| LAN auto-login | Aurral adapter |
| Instance API key | Aurral adapter |
| Subsonic protocol credentials and tokens | Aurral adapter |
| Media and WebSocket transport tokens | Aurral adapter |
