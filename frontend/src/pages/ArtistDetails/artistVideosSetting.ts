import { userToggle } from "../../hooks/userToggle.ts";

export const { set: setArtistVideos, use: useArtistVideos } = userToggle("artist-videos", true);
