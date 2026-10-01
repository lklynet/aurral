import { createHash } from "node:crypto";
import { solidPng } from "../runtime.mjs";

export const NEWS_HOSTS = [
  "consequence.net", "www.nme.com", "feeds.npr.org", "pitchfork.com", "www.rollingstone.com", "www.theguardian.com",
  "www.udiscovermusic.com", "www.stereogum.com", "www.altpress.com", "www.brooklynvegan.com", "www.gorillavsbear.net",
  "atwoodmagazine.com", "www.stereofox.com", "newmusicbuff.com", "highclouds.org", "fluxblog.org", "indiemusicfilter.com",
  "hiphopwired.com", "rapradar.com", "thisisrnb.com", "popjustice.com", "eqmusicblog.com", "www.thismustbepop.com",
  "mixmag.net", "dancingastronaut.com", "www.edmsauce.com", "www.youredm.com", "metalinjection.net", "www.metalsucks.net",
  "www.metalunderground.com", "www.savingcountrymusic.com", "theboot.com", "nodepression.com", "jazzjournal.co.uk",
  "nextbop.com", "www.allaboutjazz.com", "slippedisc.com", "icareifyoulisten.com", "www.classical-music.com",
  "www.reggaeville.com", "www.theaureview.com", "www.grimygoods.com", "www.jambase.com",
];
const HEADLINES = [
  (artist) => `${artist.name} announce a synthetic world tour`,
  (artist) => `${artist.name} share a new single from the Lab`,
  (artist) => `Revisiting ${artist.name}'s ${artist.albums[0].title}`,
];
const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function createNews(catalog) {
  const offset = (host) => createHash("sha1").update(host).digest()[0];
  const articles = (host) => HEADLINES.map((headline, index) => {
    const artist = catalog.artists[(offset(host) + index) % catalog.artists.length];
    const slug = createHash("sha1").update(`${host}:${artist.id}:${index}`).digest("hex").slice(0, 12);
    return {
      slug,
      title: headline(artist),
      description: `${artist.name} news from the Aurral Lab feed at ${host}.`,
      url: `https://${host}/lab-news/${slug}`,
      image: `https://${host}/lab-news/${slug}.png`,
      embedImage: index !== 1,
      publishedAt: new Date(Date.now() - (index + 1) * 3_600_000 - offset(host) * 60_000).toUTCString(),
    };
  });
  const feed = (host) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
<title>${escape(host)} (Aurral Lab)</title>
<link>https://${host}/</link>
<description>Synthetic music news for the Aurral Lab</description>
${articles(host).map((article) => `<item>
<title>${escape(article.title)}</title>
<link>${article.url}</link>
<description>${escape(article.description)}</description>
<pubDate>${article.publishedAt}</pubDate>
${article.embedImage ? `<media:content url="${article.image}" medium="image" />` : ""}
</item>`).join("\n")}
</channel>
</rss>`;

  const handle = ({ method, url, host }) => {
    if (method !== "GET") return null;
    const article = /^\/lab-news\/([0-9a-f]{12})(\.png)?$/.exec(url.pathname);
    if (article?.[2]) return { status: 200, raw: solidPng(`${host}${url.pathname}`, 200), headers: { "content-type": "image/png" } };
    if (article) {
      const found = articles(host).find((entry) => entry.slug === article[1]);
      if (!found) return { status: 404, raw: "Not found", headers: { "content-type": "text/plain" } };
      return {
        status: 200,
        raw: `<!doctype html><html><head><title>${escape(found.title)}</title><meta property="og:image" content="${found.image}"></head><body><h1>${escape(found.title)}</h1><p>${escape(found.description)}</p></body></html>`,
        headers: { "content-type": "text/html; charset=utf-8" },
      };
    }
    if (/(feed|rss|\.xml)/.test(url.pathname)) return { status: 200, raw: feed(host), headers: { "content-type": "application/rss+xml; charset=utf-8" } };
    return null;
  };
  return { name: "news", hosts: NEWS_HOSTS, handle };
}
