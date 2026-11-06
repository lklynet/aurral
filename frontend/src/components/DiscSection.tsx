import type { ReactNode } from "react";
import "./DiscSection.css";

// A heading above the first track of each disc of an album, such as a box set.
export function DiscSection({ children }: { children: ReactNode }) {
  return (
    <div className="native-library-track-section" role="presentation">
      {children}
    </div>
  );
}
