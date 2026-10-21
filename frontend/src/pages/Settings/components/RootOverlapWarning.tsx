import type { computeLibraryRootOverlaps } from "../../../../../backend/services/downloadFolderConfig.ts";
import { describeRootOverlapWarning } from "../utils/librarySettings";

type RootWarning = ReturnType<typeof computeLibraryRootOverlaps>[number];

export function RootOverlapWarning({ rootWarnings }: { rootWarnings?: RootWarning[] }) {
  const warning = describeRootOverlapWarning(rootWarnings);
  if (!warning) return null;
  return (
    <div className="arr-info arr-info--warning" role="status">
      <p className="arr-info__lead">{warning.summary}</p>
      {warning.details.map((detail) => (
        <p key={detail} className="arr-info__help">
          {detail}
        </p>
      ))}
    </div>
  );
}
