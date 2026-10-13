import { postData, resolveApiPath } from "../core.js";

export const cacheImageLocally = async (src) => {
  const result = await postData("/image-proxy", { src });
  return result?.url ? resolveApiPath(result.url) : null;
};
