import { parseResponse } from "hono/client";
import { resolveApiPath } from "../core.ts";
import { imageProxyClient } from "../clients/imageProxy.ts";

const IMAGE_PROXY_PATH = /^\/api\/image-proxy\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i;

export const cacheImageLocally = async (src: string) => {
  const { url } = await parseResponse(imageProxyClient.$post({ json: { src } }));
  return IMAGE_PROXY_PATH.test(url) ? resolveApiPath(url) : null;
};
