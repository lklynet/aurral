import { isSameCoreAlbum } from "../downloadJobs/deemixSearch.ts";
import type { DownloadJob } from "../downloadJobs/downloadTracker.ts";
import { getLibraryForArtistReferences } from "../libraryQueryService.ts";

// Lidarr doesn't write MusicBrainz tags by default, so untagged albums match by title.
export function filedAlbumFiles(job: DownloadJob) {
  const library = getLibraryForArtistReferences({
    source: "readonly",
    availableOnly: true,
    references: [job.artistMbid, job.artistName],
  });
  const mbids = new Set([job.albumMbid, job.releaseMbid].filter(Boolean));
  const albumIds = new Set(
    library.albums
      .filter((album) =>
        album.mbid || album.releaseGroupMbid
          ? mbids.has(album.mbid) || mbids.has(album.releaseGroupMbid)
          : isSameCoreAlbum(album.title, job.albumName),
      )
      .map((album) => album.id),
  );
  const files = library.tracks.flatMap((track) =>
    track.files.filter(
      (file) =>
        file.source === "readonly" &&
        file.available &&
        (file.albumId === null
          ? track.albums.some((entry) => albumIds.has(entry.albumId))
          : albumIds.has(file.albumId)),
    ),
  );
  return [...new Set(files.map((file) => file.path))];
}
