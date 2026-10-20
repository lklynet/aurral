import { postData, resolveApiPath } from "../core.js";

const IMAGE_PROXY_PATH = /^\/api\/image-proxy\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i;

export const cacheImageLocally = async (src) => {
  const result = await postData("/image-proxy", { src });
  const path = String(result?.url || "");
  return IMAGE_PROXY_PATH.test(path) ? resolveApiPath(path) : null;
};
