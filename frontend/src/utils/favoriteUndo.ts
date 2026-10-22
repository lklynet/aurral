import type { useToast } from "../contexts/ToastContext.tsx";
import { restoreLibraryFavorites } from "./api/endpoints/library.ts";

type FavoriteRemoval = { id: string; starredAt: number };

export const showFavoriteRemoved = (
  toast: ReturnType<typeof useToast>,
  {
    name,
    removed,
    restore,
    revert,
    onRestored,
  }: {
    name: string | null | undefined;
    removed: FavoriteRemoval[] | false | undefined;
    restore: () => void;
    revert: () => void;
    onRestored?: () => void;
  },
) => {
  const label = String(name || "").trim() || "Item";
  if (!Array.isArray(removed) || !removed.length) {
    toast.showSuccess(`Removed ${label} from favorites`);
    return;
  }
  toast.addToast(
    {
      message: `Removed ${label} from favorites`,
      action: {
        label: "Undo",
        onClick: async () => {
          restore();
          try {
            await restoreLibraryFavorites(removed);
            onRestored?.();
          } catch {
            revert();
            toast.showError(
              `Could not add ${label} back to favorites. It is still removed. Try again from its menu.`,
            );
          }
        },
      },
    },
    "success",
    8000,
  );
};
