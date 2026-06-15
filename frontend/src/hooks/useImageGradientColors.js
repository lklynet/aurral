import { useEffect, useState } from "react";
import { extractTwoToneGradientFromImage } from "../utils/imageColors";

export function useImageGradientColors(src) {
  const [colors, setColors] = useState(null);

  useEffect(() => {
    if (!src) {
      setColors(null);
      return undefined;
    }

    let cancelled = false;
    setColors(null);

    extractTwoToneGradientFromImage(src).then((result) => {
      if (!cancelled) {
        setColors(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [src]);

  return colors;
}
