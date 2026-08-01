import assert from "node:assert/strict";
import test from "node:test";

import {
  pickBestPlexConnection,
  resolvePlexConnectionUrl,
} from "../../frontend/src/pages/Settings/utils/plexConnections.js";

test("resolvePlexConnectionUrl prefers direct local HTTP over plex.direct URIs", () => {
  assert.equal(
    resolvePlexConnectionUrl({
      uri: "https://192-168-1-63.1234567890abcdef.plex.direct:32400",
      local: true,
      address: "192.168.1.63",
      port: "32400",
    }),
    "http://192.168.1.63:32400",
  );
});

test("resolvePlexConnectionUrl handles a local address that already includes its port", () => {
  assert.equal(
    resolvePlexConnectionUrl({
      uri: "https://192-168-1-63.1234567890abcdef.plex.direct:32400",
      local: true,
      address: "192.168.1.63:32400",
      port: "32400",
    }),
    "http://192.168.1.63:32400",
  );
});

test("pickBestPlexConnection falls back to the first usable remote URI", () => {
  const connection = pickBestPlexConnection({
    connections: [
      { uri: "", local: false },
      { uri: "https://plex.example.com:32400", local: false },
    ],
  });

  assert.deepEqual(connection, {
    uri: "https://plex.example.com:32400",
    local: false,
  });
});
