import assert from "node:assert/strict";
import type { Router, RequestHandler } from "express";
import type { PlaylistTrack } from "../../backend/services/playlists/flowPlaylistConfig.ts";

export function requireFixture<T>(value: T) {
  assert.ok(value != null, "Expected fixture to exist");
  return value;
}

type TestHandler = (request: object, response: object) => unknown;

export function captureRoutes(
  key: (method: string, path: string) => string = (_method: string, path: string) => path,
) {
  const handlers = new Map<string, TestHandler>();
  const router = Object.fromEntries(
    ["get", "post", "put", "patch", "delete"].map((method) => [
      method,
      (path: string, ...callbacks: RequestHandler[]) => {
        handlers.set(key(method, path), requireFixture(callbacks.at(-1)) as TestHandler);
      },
    ]),
  ) as unknown as Router;
  return { router, handlers };
}

export function mockResponse<T>() {
  let body: T | undefined;
  return {
    statusCode: 200,
    get body() {
      return requireFixture(body);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: T) {
      body = value;
      return this;
    },
  };
}

export function playlistTrack(
  track: Pick<PlaylistTrack, "artistName" | "trackName"> & Partial<PlaylistTrack>,
): PlaylistTrack {
  return {
    albumName: null,
    artistMbid: null,
    albumMbid: null,
    trackMbid: null,
    releaseYear: null,
    durationMs: null,
    artistAliases: [],
    reason: null,
    ...track,
  };
}
