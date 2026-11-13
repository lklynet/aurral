import PQueue from "p-queue";
import { http } from "../../../lib/http.ts";
import { createOutagePause } from "./outagePause.ts";

const REQUEST_TIMEOUT_MS = 2000;
const queue = new PQueue({ concurrency: 4 });
const pause = createOutagePause("Cover Art Archive");

// The archive answers with a redirect to the image file, whose name carries
// the release and image IDs. BrainzMash builds its cover addresses from the
// same two IDs, so this is the address an album lookup would have given.
export async function findReleaseGroupCoverUrl(releaseGroupMbid: string) {
  const response = await queue.add(() =>
    pause.run(() =>
      http.get(`https://coverartarchive.org/release-group/${releaseGroupMbid}/front`, {
        redirect: "manual",
        timeoutMs: REQUEST_TIMEOUT_MS,
        okStatus: (status) => status === 307 || status === 404,
      }),
    ),
  );
  const [, releaseMbid, imageId] =
    /\/mbid-([0-9a-f-]{36})-(\d+)\.\w+$/i.exec(response.headers.location ?? "") ?? [];
  return releaseMbid && imageId
    ? `https://imagecache.lidarr.audio/v1/caa/${releaseMbid}/${imageId}-1200.jpg`
    : null;
}
