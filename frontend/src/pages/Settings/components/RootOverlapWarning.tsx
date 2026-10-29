import type { computeLibraryRootOverlaps } from "../../../../../backend/services/downloadFolderConfig.ts";
import { SettingsNote } from "../SettingsLayout";
import { describeRootOverlapWarning } from "../utils/librarySettings";

type RootWarning = ReturnType<typeof computeLibraryRootOverlaps>[number];

export function RootOverlapWarning({ rootWarnings }: { rootWarnings?: RootWarning[] }) {
  const warning = describeRootOverlapWarning(rootWarnings);
  if (!warning) return null;
  return (
    <SettingsNote tone="warning">{[...warning.details, warning.summary].join(" ")}</SettingsNote>
  );
}
