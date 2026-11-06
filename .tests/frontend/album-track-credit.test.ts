import assert from "node:assert/strict";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vite-plus/test";
import { TrackList } from "../../frontend/src/components/TrackList.tsx";
import {
  ArtistCreditLinks,
  trackArtistCredit,
} from "../../frontend/src/pages/album/trackCredit.tsx";

const KENDRICK = "381086ea-f511-4aba-bdf9-71c753dc5077";
const SZA = "272989c8-5535-492d-a25c-9f58803e027f";
const allTheStars = [
  { name: "Kendrick Lamar", mbid: KENDRICK, joinPhrase: ", " },
  { name: "SZA", mbid: SZA, joinPhrase: "" },
];

test("keeps a credit that names more than the album artist", () => {
  assert.equal(
    trackArtistCredit(allTheStars, { name: "Kendrick Lamar", mbid: KENDRICK }),
    allTheStars,
  );
});

test("drops a credit that only names the album artist", () => {
  const solo = [{ name: "Kendrick Lamar", mbid: KENDRICK, joinPhrase: "" }];
  assert.equal(trackArtistCredit(solo, { name: "kendrick lamar", mbid: null }), null);
  assert.equal(trackArtistCredit([], { name: "Kendrick Lamar", mbid: KENDRICK }), null);
  assert.equal(trackArtistCredit(undefined, { name: "Kendrick Lamar", mbid: KENDRICK }), null);
});

test("matches the album artist by MBID when the names are spelled differently", () => {
  const credit = [{ name: "Sigur Rós", mbid: "sigur", joinPhrase: "" }];
  assert.equal(trackArtistCredit(credit, { name: "Sigur Ros", mbid: "sigur" }), null);
});

test("drops a duo credit that matches a duo album artist by name", () => {
  const duo = [
    { name: "Anderson .Paak", mbid: "paak", joinPhrase: " & " },
    { name: "Cordae", mbid: "cordae", joinPhrase: "" },
  ];
  assert.equal(trackArtistCredit(duo, { name: "Anderson .Paak & Cordae", mbid: "paak" }), null);
});

test("links each credited artist to their Discover page", () => {
  const credit = [...allTheStars, { name: "Unknown", mbid: null, joinPhrase: "" }];
  const parts = Children.toArray(
    (ArtistCreditLinks({ credit }) as ReactElement<{ children: ReactElement[] }>).props.children,
  ).flatMap((part) =>
    Children.toArray((part as ReactElement<{ children: ReactNode }>).props.children),
  );
  assert.deepEqual(
    parts
      .filter((part) => part !== "")
      .map((part) =>
        isValidElement<{ to: string; children: string }>(part)
          ? `[${part.props.children}](${part.props.to})`
          : part,
      ),
    [`[Kendrick Lamar](/artist/${KENDRICK})`, ", ", `[SZA](/artist/${SZA})`, "Unknown"],
  );
});

test("a playable title keeps credit links outside its play button", () => {
  const html = renderToStaticMarkup(
    createElement(TrackList, {
      label: "Tracks",
      variant: "release",
      rows: [
        {
          key: 1,
          number: 1,
          title: "All the Stars",
          onPlay: () => {},
          subtitle: createElement("a", { href: `/artist/${SZA}` }, "SZA"),
        },
      ],
    }),
  );
  assert.match(
    html,
    /<button type="button" class="native-library-track__title-action" aria-label="All the Stars"[^>]*><\/button>/,
  );
  assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>).)*<a /s);
  assert.match(
    html,
    /<span>All the Stars<\/span><small><a href="\/artist\/[^"]+">SZA<\/a><\/small>/,
  );
});
