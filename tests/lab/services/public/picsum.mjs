import { solidPng } from "../runtime.mjs";

export function createPicsum() {
  const handle = ({ method, url }) => {
    const size = /^\/(\d{2,4})(?:\/(\d{2,4}))?$/.exec(url.pathname);
    if (method !== "GET" || !size) return null;
    return { status: 200, raw: solidPng(url.search || url.pathname, Math.min(Number(size[1]), 1200)), headers: { "content-type": "image/png" } };
  };
  return { name: "picsum", hosts: ["picsum.photos"], handle };
}
