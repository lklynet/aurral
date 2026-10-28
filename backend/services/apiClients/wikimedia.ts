import axios from "../../../lib/axiosFetch.ts";
import { APP_NAME, APP_VERSION } from "../../config/constants.ts";

const PHOTO_WIDTH = 960;
const request = {
  headers: { "User-Agent": `${APP_NAME}/${APP_VERSION} (https://github.com/lklynet/aurral)` },
  timeout: 5000,
  validateStatus: (status: number) => (status >= 200 && status < 300) || status === 404,
};

type WikidataStatement = { rank?: string; value?: { content?: unknown } };
type CommonsImageInfo = { thumburl?: string; url?: string };

const wikidataItemId = (links: { target?: unknown }[] | null | undefined) =>
  (links || [])
    .map((link) => /^https?:\/\/www\.wikidata\.org\/wiki\/(Q\d+)$/i.exec(String(link?.target))?.[1])
    .find(Boolean);

export async function wikimediaGetArtistPhotoUrl(links: { target?: unknown }[] | null | undefined) {
  const itemId = wikidataItemId(links);
  if (!itemId) return null;
  const statements = await axios.get(
    `https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/${itemId}/statements`,
    { ...request, params: { property: "P18" } },
  );
  const images: WikidataStatement[] = statements.data?.P18 || [];
  const file = (
    images.find((image) => image.rank === "preferred") ||
    images.find((image) => image.rank !== "deprecated")
  )?.value?.content;
  if (typeof file !== "string" || !file.trim()) return null;
  const info = await axios.get("https://commons.wikimedia.org/w/api.php", {
    ...request,
    params: {
      action: "query",
      prop: "imageinfo",
      iiprop: "url",
      iiurlwidth: PHOTO_WIDTH,
      titles: `File:${file}`,
      format: "json",
      formatversion: 2,
    },
  });
  const image: CommonsImageInfo | undefined = info.data?.query?.pages?.[0]?.imageinfo?.[0];
  const url = image?.thumburl || image?.url;
  return url ? url.split("?")[0] : null;
}
