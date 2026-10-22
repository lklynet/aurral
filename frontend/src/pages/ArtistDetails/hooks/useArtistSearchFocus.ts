import { useEffect, useRef } from "react";

export function useArtistSearchFocus({ navigate, mbid, locationState }) {
  const focusReleaseGroupMbid = locationState?.focusReleaseGroupMbid || null;
  const focusTrackMbid = locationState?.focusTrackMbid || null;
  const appliedRef = useRef(false);

  useEffect(() => {
    appliedRef.current = false;
  }, [mbid, focusReleaseGroupMbid, focusTrackMbid]);

  useEffect(() => {
    if (appliedRef.current || !focusReleaseGroupMbid || !mbid) return;

    appliedRef.current = true;
    navigate(`/artist/${mbid}/release/${focusReleaseGroupMbid}`, {
      replace: true,
      state: {
        artistName: locationState?.artistName,
        inLibrary: locationState?.inLibrary,
        libraryArtist: locationState?.libraryArtist,
        focusReleaseGroup: locationState?.focusReleaseGroup,
        focusTrackMbid,
        focusTrackTitle: locationState?.focusTrackTitle,
      },
    });
  }, [focusReleaseGroupMbid, focusTrackMbid, locationState, mbid, navigate]);
}
