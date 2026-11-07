import * as v from "valibot";
import { http, type HttpOptions } from "../../../lib/http.ts";
import { readOne } from "../integrationData.ts";
import { APP_NAME, APP_VERSION } from "../../config/constants.ts";

const PHOTO_WIDTH = 960;
const request: HttpOptions = {
  headers: { "User-Agent": `${APP_NAME}/${APP_VERSION} (https://github.com/lklynet/aurral)` },
  timeoutMs: 5000,
  okStatus: (status: number) => (status >= 200 && status < 300) || status === 404,
};

const statementsSchema = v.looseObject({
  P18: v.optional(
    v.array(
      v.looseObject({
        rank: v.optional(v.string()),
        value: v.optional(v.looseObject({ content: v.optional(v.unknown()) })),
      }),
    ),
  ),
});

const imageInfoSchema = v.looseObject({
  query: v.optional(
    v.looseObject({
      pages: v.optional(
        v.array(
          v.looseObject({
            imageinfo: v.optional(
              v.array(
                v.looseObject({ thumburl: v.optional(v.string()), url: v.optional(v.string()) }),
              ),
            ),
          }),
        ),
      ),
    }),
  ),
});

const wikidataItemId = (links: { target?: unknown }[] | null | undefined) =>
  (links || [])
    .map((link) => /^https?:\/\/www\.wikidata\.org\/wiki\/(Q\d+)$/i.exec(String(link?.target))?.[1])
    .find(Boolean);

export async function wikimediaGetArtistPhotoUrl(links: { target?: unknown }[] | null | undefined) {
  const itemId = wikidataItemId(links);
  if (!itemId) return null;
  const statements = await http.get(
    `https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/${itemId}/statements`,
    { ...request, query: { property: "P18" } },
  );
  const images =
    readOne(statementsSchema, statements.data, { service: "Wikidata", endpoint: "/statements" })
      .P18 || [];
  const file = (
    images.find((image) => image.rank === "preferred") ||
    images.find((image) => image.rank !== "deprecated")
  )?.value?.content;
  if (typeof file !== "string" || !file.trim()) return null;
  const info = await http.get("https://commons.wikimedia.org/w/api.php", {
    ...request,
    query: {
      action: "query",
      prop: "imageinfo",
      iiprop: "url",
      iiurlwidth: PHOTO_WIDTH,
      titles: `File:${file}`,
      format: "json",
      formatversion: 2,
    },
  });
  const image = readOne(imageInfoSchema, info.data, {
    service: "Wikimedia Commons",
    endpoint: "/w/api.php",
  }).query?.pages?.[0]?.imageinfo?.[0];
  const url = image?.thumburl || image?.url;
  return url ? url.split("?")[0] : null;
}
