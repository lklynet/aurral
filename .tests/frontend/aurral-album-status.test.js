import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAurralAlbumRetryPayload,
  describeAurralAlbumStatus,
  shouldPollAlbumStatus,
} from "../../frontend/src/utils/aurralAlbumStatus.js";

const actionLabels = (state) => state.actions.map((action) => action.label);

test("every Aurral album status has a visible label and the right actions", () => {
  const expected = {
    queued: ["Queued", ["Cancel downloads"]],
    downloading: ["Downloading", ["Cancel downloads"]],
    partial: ["Partially available", []],
    complete: ["In library", []],
    failed: ["Failed", ["Retry"]],
    blocked: ["Needs attention", []],
    cancelled: ["Cancelled", ["Retry"]],
    missing: ["Missing", ["Download missing tracks"]],
  };
  for (const [status, [label, actions]] of Object.entries(expected)) {
    const state = describeAurralAlbumStatus({ status, recovery: null });
    assert.equal(state.label, label, status);
    assert.deepEqual(actionLabels(state), actions, status);
    assert.equal(state.recovery, null, status);
  }
});

test("missing albums offer to download missing tracks instead of Retry", () => {
  const state = describeAurralAlbumStatus({ status: "missing" });
  assert.deepEqual(state.actions, [{ id: "retry", label: "Download missing tracks" }]);
});

test("a partial album offers Retry only when a source failed", () => {
  const recovery = { code: "source_failed", message: "No source had the tracks." };
  const state = describeAurralAlbumStatus({ status: "partial", recovery });
  assert.deepEqual(actionLabels(state), ["Retry"]);
  assert.deepEqual(state.recovery, {
    code: "source_failed",
    message: "No source had the tracks.",
    link: null,
  });
});

test("recovery codes link to the place that fixes them", () => {
  const sourceMissing = describeAurralAlbumStatus({
    status: "blocked",
    recovery: { code: "download_source_missing", message: "Configure a download client." },
  });
  assert.deepEqual(actionLabels(sourceMissing), []);
  assert.equal(sourceMissing.recovery.message, "Configure a download client.");
  assert.equal(sourceMissing.recovery.link.to, "/settings/download-clients");

  const review = describeAurralAlbumStatus({
    status: "blocked",
    recovery: { code: "review_required", message: "Some tracks need review." },
  });
  assert.equal(review.recovery.message, "Some tracks need review.");
  assert.equal(review.recovery.link.to, "/activity/queue");

  const failed = describeAurralAlbumStatus({
    status: "failed",
    recovery: { code: "source_failed", message: "Search failed." },
  });
  assert.deepEqual(actionLabels(failed), ["Retry"]);
  assert.equal(failed.recovery.link, null);
});

test("unknown or Lidarr statuses produce no Aurral state", () => {
  assert.equal(describeAurralAlbumStatus({ status: "added" }), null);
  assert.equal(describeAurralAlbumStatus({ status: "searching" }), null);
  assert.equal(describeAurralAlbumStatus(), null);
});

test("polling continues only while work is queued or downloading", () => {
  const polling = ["queued", "downloading", "partial", "complete", "failed", "blocked", "cancelled", "missing", undefined]
    .filter(shouldPollAlbumStatus);
  assert.deepEqual(polling, ["queued", "downloading"]);
});

test("retry re-requests the album through Aurral", () => {
  assert.deepEqual(
    buildAurralAlbumRetryPayload({
      album: { id: 12, mbid: "album-mbid", title: "Disposable Album" },
      artist: { id: 3, mbid: "artist-mbid", name: "Disposable Artist" },
    }),
    {
      albumMbid: "album-mbid",
      albumName: "Disposable Album",
      artistMbid: "artist-mbid",
      artistName: "Disposable Artist",
      managedBy: "aurral",
    },
  );
  assert.equal(
    buildAurralAlbumRetryPayload({ album: { releaseGroupMbid: "rg-mbid", title: "A" }, artist: {} }).albumMbid,
    "rg-mbid",
  );
});
