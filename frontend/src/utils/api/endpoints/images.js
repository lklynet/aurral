import { postData } from "../core.js";

export const cacheImageLocally = (src) => postData("/image-proxy", { src });
