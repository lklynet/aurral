# Validating integration data

Status: Accepted

## Problem

Aurral trusted data from integrations to match its declared types, and many bugs fixed during the TypeScript port came from that, like Lidarr sending an object where the code expected a string. Aurral also writes some of that data back: Lidarr edits fetch an artist or album, change one field, and send the whole object back.

## Decision

Each integration client parses what it reads with a Valibot schema at its boundary, and the schema is the type. Clients parse with `readOne` and `readMany` from `backend/services/integrationData.ts`.

- **Schemas keep unknown keys.** Use `v.looseObject` at every level. `v.object` drops keys it doesn't list, so a parsed artist sent back to Lidarr would erase every field Aurral doesn't read.
- **Declare only what Aurral reads.** Every declared field is one more way for a record to fail. Everything else passes through untouched and types as `unknown`.
- **Describe what the service sends.** Check a running instance before accepting another shape. slskd's client once read every field in two casings and unwrapped `$values` lists, and slskd sends neither.
- **Follow the service's own nullability, except for what Aurral can't do without.** For Lidarr that is its OpenAPI spec: strings can be `null`, numbers and booleans can be missing but not `null`. A field is required only when a record is useless without it, like an id, an album's MusicBrainz id, or a profile's name.
- **Lists skip, single records fail.** One odd album shouldn't hide the rest of a library, so a list drops the records that fail and logs one warning per response. A single record that fails throws, so Aurral never writes back data it couldn't read.
- **Parse before caching.** The client parses inside its request path, so caches and in-flight dedupe hold parsed data and a list is parsed once per fetch. A cached endpoint must always use the same schema, so code outside the client reads through client methods, not `request()`.

## Traps

- `Omit` on a loose type keeps only its `[key: string]: unknown` index signature and loses the named fields. `Pick`, `Partial`, and intersections keep them.
- A test that mocks `request()` skips parsing, so the mock has to return the parsed shape.
