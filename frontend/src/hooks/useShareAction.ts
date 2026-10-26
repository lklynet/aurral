import { useShareContext } from "../contexts/ShareContext";

export function useShareAction() {
  return useShareContext().openShare;
}

export function useLibraryShareAction() {
  return useShareContext().openShare;
}
