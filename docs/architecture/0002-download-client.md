# Download client seam

- Status: Accepted
- Date: 2026-08-27

## Context

Aurral selects a download source before it starts a playlist job. The current flow calls each provider client directly, and the Download Clients page repeats each provider's fields and test action. That makes a new client require changes in several unrelated places.

## Decision

`backend/services/download/downloadClient.js` defines the common download client contract:

- `isConfigured()`
- `testConnection(options)`
- `getStatus()`
- `updateConfig(config)`

`DownloadClientRegistry` keeps the registered clients, updates their configuration, and returns a client by its key. The registry does not force provider protocols into one API. Search, queue, transfer, and cleanup methods stay on the provider client that owns them.

The built-in adapters keep their settings metadata beside their client code. `GET /api/settings/download-clients` returns the metadata without saved values. The metadata describes fields, defaults, validation, advanced fields, and the client test action. The frontend uses that metadata to build the client cards and settings modals.

`POST /api/settings/download-clients/:key/test` creates the selected adapter, applies the submitted configuration, and tests the connection. The existing provider-specific test routes remain for compatibility.

## Built-in clients

The registry currently contains slskd, yt-dlp, NZBGet, SABnzbd, and deemix. Prowlarr remains an indexer service because it searches for Usenet releases and does not receive downloads.

The orchestration code selects clients through the registry. Provider-specific methods continue to run on the selected adapter, so each client can keep its own protocol and download state.

## Deliberate non-goals

- Do not add plugin loading or uploaded code.
- Do not move provider protocol behavior into the registry.
- Do not return saved credentials in settings metadata.
