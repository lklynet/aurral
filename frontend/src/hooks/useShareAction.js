import { useShareContext } from "../contexts/ShareContext";

export function useShareAction() {
  return useShareContext().openShare;
}
