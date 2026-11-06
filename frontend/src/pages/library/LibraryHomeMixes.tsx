import { DiscoverPlaylistSection } from "../DiscoverPlaylistSection";
import { useMadeForYou } from "../usePlaylistShelf";

export function LibraryHomeMixes() {
  const { data } = useMadeForYou();
  return (
    <DiscoverPlaylistSection
      title="Your mixes"
      playlists={data?.mixes}
      viewAllTo="/discover/playlists?filter=made-for-you"
    />
  );
}
