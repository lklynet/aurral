import { useEffect, useRef } from "react";

interface ArtistSearchFocusState {
  focusReleaseGroupMbid?: string | null;
  focusTrackMbid?: string | null;
  focusTrackTitle?: string | null;
  artistName?: string | null;
  inLibrary?: boolean;
  libraryArtist?: unknown;
  focusReleaseGroup?: unknown;
}

interface ArtistSearchFocusOptions {
  navigate: (to: string, options: { replace: boolean; state: unknown }) => void;
  mbid: string | undefined;
  locationState: ArtistSearchFocusState | null | undefined;
}

export function useArtistSearchFocus({ navigate, mbid, locationState }: ArtistSearchFocusOptions) {
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
