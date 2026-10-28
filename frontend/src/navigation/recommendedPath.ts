const VIEW_KEY = "recommendedView";

export const RECOMMENDED_PATH = "/discover/recommended";
export const RECOMMENDED_ALL_PATH = `${RECOMMENDED_PATH}/all`;

export type RecommendedView = "for-you" | "all";

export const recommendedListPath = (params: Record<string, string> = {}) => {
  const search = new URLSearchParams(params).toString();
  return search ? `${RECOMMENDED_ALL_PATH}?${search}` : RECOMMENDED_ALL_PATH;
};

export const lastRecommendedPath = (pathname = "") => {
  if (pathname.startsWith(RECOMMENDED_ALL_PATH)) return RECOMMENDED_ALL_PATH;
  if (pathname.startsWith(RECOMMENDED_PATH)) return RECOMMENDED_PATH;
  try {
    return localStorage.getItem(VIEW_KEY) === "all" ? RECOMMENDED_ALL_PATH : RECOMMENDED_PATH;
  } catch {
    return RECOMMENDED_PATH;
  }
};

export const rememberRecommendedView = (view: RecommendedView) => {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {}
};
