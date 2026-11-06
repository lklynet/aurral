import { DiscoverPlaylistSection } from "../DiscoverPlaylistSection";
import { useMadeForYou } from "../usePlaylistShelf";

export function LibraryHomeMixes() {
  const { data } = useMadeForYou();
  return <DiscoverPlaylistSection title="Your mixes" playlists={data?.mixes} />;
}
