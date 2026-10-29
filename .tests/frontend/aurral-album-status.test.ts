import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  buildAurralAlbumRetryPayload,
  describeAurralAlbumStatus,
  shouldPollAlbumStatus,
  shouldPollAlbumStatuses,
} from "../../frontend/src/utils/aurralAlbumStatus.ts";

const actionLabels = (state: NonNullable<ReturnType<typeof describeAurralAlbumStatus>>) =>
  state.actions.map((action) => action.label);

test("a partial album offers Retry when a source failed and otherwise downloads missing tracks", () => {
  const recovery = { code: "source_failed" as const, message: "No source had the tracks." };
  const state = describeAurralAlbumStatus({ status: "partial", recovery });
  assert.ok(state != null);
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
  assert.ok(sourceMissing != null);
  assert.deepEqual(actionLabels(sourceMissing), []);
  assert.equal(sourceMissing.recovery?.message, "Configure a download client.");
  assert.deepEqual(sourceMissing.recovery?.link, {
    settings: "downloads",
    label: "Set up a download client",
  });

  const review = describeAurralAlbumStatus({
    status: "blocked",
    recovery: { code: "review_required", message: "Some tracks need review." },
  });
  assert.ok(review != null);
  assert.equal(review.recovery?.message, "Some tracks need review.");
  assert.deepEqual(review.recovery?.link, { to: "/activity/queue", label: "Review in Activity" });

  const failed = describeAurralAlbumStatus({
    status: "failed",
    recovery: { code: "source_failed", message: "Search failed." },
  });
  assert.ok(failed != null);
  assert.deepEqual(actionLabels(failed), ["Retry"]);
  assert.equal(failed.recovery?.link, null);
});

test("unknown or Lidarr statuses produce no Aurral state", () => {
  assert.equal(describeAurralAlbumStatus({ status: "added" }), null);
  assert.equal(describeAurralAlbumStatus({ status: "searching" }), null);
  assert.equal(describeAurralAlbumStatus(), null);
});

test("polling continues only while work is queued or downloading", () => {
  const polling = [
    "queued",
    "downloading",
    "partial",
    "complete",
    "failed",
    "blocked",
    "cancelled",
    "missing",
    undefined,
  ].filter(shouldPollAlbumStatus);
  assert.deepEqual(polling, ["queued", "downloading"]);
});

test("library lists poll only while an album in the batch is active", () => {
  assert.equal(shouldPollAlbumStatuses({}), false);
  assert.equal(shouldPollAlbumStatuses(undefined), false);
  assert.equal(
    shouldPollAlbumStatuses({
      "aurral:1": { status: "complete" },
      "aurral:2": { status: "failed" },
    }),
    false,
  );
  assert.equal(
    shouldPollAlbumStatuses({
      "aurral:1": { status: "complete" },
      "aurral:2": { status: "queued" },
    }),
    true,
  );
});

test("retry re-requests the album through Aurral", () => {
  assert.deepEqual(
    buildAurralAlbumRetryPayload({
      album: { mbid: "album-mbid", title: "Disposable Album" },
      artist: { mbid: "artist-mbid", name: "Disposable Artist" },
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
    buildAurralAlbumRetryPayload({ album: { releaseGroupMbid: "rg-mbid", title: "A" }, artist: {} })
      .albumMbid,
    "rg-mbid",
  );
});
