import { useCallback, useState } from "react";
import type { ArtworkLightboxState } from "../components/ArtworkLightbox";

export function useArtworkLightbox() {
  const [artwork, setArtwork] = useState<ArtworkLightboxState>(null);

  const open = useCallback((src: string | null | undefined, alt: string) => {
    if (!src) return;
    setArtwork({ src, alt });
  }, []);

  const close = useCallback(() => setArtwork(null), []);

  return { artwork, open, close };
}
