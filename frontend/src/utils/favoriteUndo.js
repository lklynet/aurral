import { restoreLibraryFavorites } from "./api/endpoints/library.js";

export const showFavoriteRemoved = (toast, { name, removed, restore, revert, onRestored }) => {
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
            toast.showError(`Could not add ${label} back to favorites. It is still removed. Try again from its menu.`);
          }
        },
      },
    },
    "success",
    8000,
  );
};
