import path from "node:path";
import { fileURLToPath } from "node:url";
import getSharp from "./sharpConfig.ts";

export const PLAYLIST_COVER_TEMPLATES = [
  "a1",
  "a2",
  "a3",
  "a4",
  "b1",
  "b2",
  "b3",
  "b4",
  "c1",
  "c2",
  "c3",
  "c4",
  "d1",
  "d2",
  "d3",
  "d4",
  "e1",
  "e2",
  "e3",
  "e4",
  "f1",
  "f2",
  "f3",
  "f4",
  "g1",
  "g2",
  "g3",
  "g4",
  "h1",
  "h2",
  "h3",
  "h4",
  "i1",
  "i2",
  "i3",
  "i4",
  "j1",
  "j2",
  "j3",
  "j4",
  "k1",
  "k2",
  "k3",
  "k4",
] as const;
export type PlaylistCoverTemplate = (typeof PLAYLIST_COVER_TEMPLATES)[number];

const FONT_DIR = fileURLToPath(new URL("../assets/playlist-fonts/", import.meta.url));
const FONTS = {
  sans: { file: "Lato.ttf", name: "Lato Black" },
  condensed: { file: "Anton.ttf", name: "Anton" },
  serif: { file: "DMSerif.ttf", name: "DM Serif Display" },
  italic: { file: "DMSerifItalic.ttf", name: "DM Serif Display Italic" },
  heavy: { file: "Abril.ttf", name: "Abril Fatface" },
  script: { file: "Caveat.ttf", name: "Caveat Bold" },
};
const SIMPLE_COLORS = [
  "#654eba",
  "#193b86",
  "#7b233c",
  "#23443d",
  "#ad293c",
  "#522b40",
  "#263a60",
  "#984324",
];
const PALETTES = {
  a1: ["#000000", "#ffffff"],
  a2: ["#e04e23", "#171516"],
  a3: ["#fff4d1", "#171516"],
  a4: ["#c4bcff", "#27233e"],
  b1: ["#efebdc", "#282718"],
  b2: ["#562331", "#f8b5c5"],
  b3: ["#193b86", "#f5eccb"],
  b4: ["#e9b84f", "#3c2625"],
  c1: ["#edeadf", "#242321"],
  c2: ["#ef674b", "#4b201a"],
  c3: ["#243ac7", "#eff2dc"],
  c4: ["#c3b2d9", "#38253d"],
  d1: ["#ed563d", "#141414"],
  d2: ["#7b233c", "#fbb6ce"],
  d3: ["#000000", "#ffffff"],
  d4: ["#000000", "#e8e8de"],
  e1: ["#2e4aa4", "#f7f0a8"],
  e2: ["#25134d", "#ffffff"],
  e3: ["#f1aacb", "#ad293c"],
  e4: ["#000000", "#ffffff"],
  f1: ["#f1e4df", "#332039"],
  f2: ["#5423a0", "#222222"],
  f3: ["#e6dfce", "#ffffff"],
  f4: ["#bd303c", "#f8e5c7"],
  g1: ["#000000", "#ffffff"],
  g2: ["#121212", "#f5edcb"],
  g3: ["#f2dc50", "#182c26"],
  g4: ["#d8d4c7", "#1d2927"],
  h1: ["#e5e5da", "#203ba3"],
  h2: ["#e9e2d4", "#b1452d"],
  h3: ["#202d60", "#f7c5dc"],
  h4: ["#ffb4ca", "#802d59"],
  i1: ["#ebe8db", "#191919"],
  i2: ["#1c1820", "#e1f1c9"],
  i3: ["#f14b38", "#361c24"],
  i4: ["#cfd263", "#1c3940"],
  j1: ["#522b40", "#f9c6d1"],
  j2: ["#141414", "#e9e4d6"],
  j3: ["#e2d78e", "#23443d"],
  j4: ["#191919", "#d5eb54"],
  k1: ["#b4c5ce", "#183246"],
  k2: ["#be333f", "#f7b9d6"],
  k3: ["#000000", "#ffffff"],
  k4: ["#d9c6ec", "#362251"],
} satisfies Record<PlaylistCoverTemplate, [string, string]>;

type Box = [x: number, y: number, width: number, height: number];
type Lettering = {
  font?: keyof typeof FONTS;
  align?: "left" | "centre" | "right";
  color?: string;
  text?: string;
  rotate?: number;
  outline?: boolean;
  photo?: boolean;
};
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export async function renderPlaylistCover({
  title,
  imageBuffer,
  template = "b1",
}: {
  title: string;
  imageBuffer?: Buffer | null;
  template?: PlaylistCoverTemplate;
}) {
  const sharp = await getSharp();
  const displayTitle = title.trim() || "Untitled";
  const [paper, ink] = imageBuffer
    ? PALETTES[template]
    : [SIMPLE_COLORS[Math.floor(Math.random() * SIMPLE_COLORS.length)], "#ffffff"];
  const source = imageBuffer
    ? (
        await sharp(imageBuffer, { animated: false })
          .rotate()
          .resize(1000, 1000, { fit: "cover", position: "attention" })
          .jpeg({ quality: 90 })
          .toBuffer()
      ).toString("base64")
    : "";
  let nextId = 0;
  const rect = ([x, y, width, height]: Box, fill: string, radius = 0) =>
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"/>`;
  const photo = (box: Box = [0, 0, 1000, 1000], shape = "", zoom = 1, position = 0.5) => {
    const [x, y, w, h] = box;
    const id = `p${nextId++}`;
    return `<defs><clipPath id="${id}">${shape || rect(box, "white")}</clipPath></defs><g clip-path="url(#${id})"><image href="data:image/jpeg;base64,${source}" x="${x - (w * zoom - w) * position}" y="${y - (h * zoom - h) * position}" width="${w * zoom}" height="${h * zoom}" preserveAspectRatio="xMidYMid slice"/></g>`;
  };
  const ellipse = ([x, y, w, h]: Box) =>
    `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"/>`;
  const arch = ([x, y, w, h]: Box) =>
    `<path d="M${x} ${y + h}V${y + w / 2}a${w / 2} ${w / 2} 0 0 1 ${w} 0V${y + h}Z"/>`;
  const rotate = (markup: string, angle: number, cx = 500, cy = 500) =>
    `<g transform="rotate(${angle} ${cx} ${cy})">${markup}</g>`;
  const lettering = new Map<string, Promise<Buffer>>();
  const text = async (box: Box, options: Lettering = {}) => {
    const [x, y, w, h] = box;
    const font = FONTS[options.font || "sans"];
    const value = options.text ?? displayTitle;
    const color = options.color || ink;
    const cacheKey = JSON.stringify([font.file, value, color, w, h, options.align]);
    let rendering = lettering.get(cacheKey);
    if (!rendering) {
      rendering = sharp({
        text: {
          text: `<span foreground="${color}" insert_hyphens="false">${xml(value)}</span>`,
          font: font.name,
          fontfile: path.join(FONT_DIR, font.file),
          width: Math.max(1, Math.round(w)),
          height: Math.max(1, Math.round(h)),
          align: options.align || "left",
          wrap: "word",
          rgba: true,
        },
      })
        .png()
        .toBuffer();
      lettering.set(cacheKey, rendering);
    }
    const rendered = await rendering;
    const id = `t${nextId++}`;
    const image = `<image href="data:image/png;base64,${rendered.toString("base64")}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="x${options.align === "right" ? "Max" : options.align === "centre" ? "Mid" : "Min"}YMid meet"/>`;
    let result = image;
    if (options.photo)
      result = `<defs><mask id="${id}">${image}</mask></defs><g mask="url(#${id})">${photo()}</g>`;
    if (options.outline)
      result = `<defs><filter id="${id}" x="-10%" y="-10%" width="120%" height="120%"><feMorphology in="SourceAlpha" operator="dilate" radius="3" result="expanded"/><feComposite in="expanded" in2="SourceAlpha" operator="out" result="edge"/><feFlood flood-color="${color}"/><feComposite in2="edge" operator="in"/></filter></defs><g filter="url(#${id})">${image}</g>`;
    return options.rotate ? rotate(result, options.rotate) : result;
  };
  const words = displayTitle.split(/\s+/);
  const halfway = Math.max(1, Math.ceil(words.length / 2));
  const first = words.slice(0, halfway).join(" ");
  const last = words.slice(halfway).join(" ");
  const split = words.join("\n");
  let art = "";
  if (!imageBuffer) art = await text([90, 110, 820, 780]);
  else
    switch (template) {
      case "a1":
        art = photo() + (await text([60, 55, 850, 390], { font: "serif" }));
        break;
      case "a2":
        art = photo([0, 0, 1000, 640]) + (await text([50, 680, 900, 275], { font: "condensed" }));
        break;
      case "a3": {
        art = photo();
        const lines = words.length <= 4 ? words : [first, last];
        const height = Math.min(650 / lines.length, 210);
        for (const [index, line] of lines.entries()) {
          const box: Box = [
            50,
            950 - height * (lines.length - index),
            Math.min(900, Math.max(320, line.length * height * 0.55)),
            height,
          ];
          art +=
            rect(box, paper) +
            (await text([box[0] + 15, box[1] + 10, box[2] - 30, box[3] - 20], { text: line }));
        }
        break;
      }
      case "a4":
        art = photo([0, 390, 1000, 610]) + (await text([50, 35, 900, 310], { font: "serif" }));
        break;
      case "b1":
        art = photo([60, 60, 880, 650]) + (await text([70, 750, 860, 205], { font: "serif" }));
        break;
      case "b2":
        art = photo([250, 440, 670, 480]) + (await text([70, 50, 860, 340], { font: "serif" }));
        break;
      case "b3":
        art =
          photo([510, 70, 420, 860]) +
          (await text([50, 70, 410, 840], { font: "sans", text: split }));
        break;
      case "b4":
        art =
          photo([180, 70, 640, 620], arch([180, 70, 640, 620])) +
          (await text([70, 740, 860, 205], { font: "serif", align: "centre" }));
        break;
      case "c1":
        for (let i = 0; i < 4; i++) {
          const b: Box = [70 + (i % 2) * 460, 280 + Math.floor(i / 2) * 340, 390, 300];
          art += photo(b, ellipse(b), 2, i / 3);
        }
        art += await text([60, 35, 880, 205], { font: "condensed" });
        break;
      case "c2":
        art =
          photo([180, 300, 1010, 800], ellipse([180, 300, 1010, 800])) +
          (await text([50, 50, 900, 280], { font: "serif" }));
        break;
      case "c3":
        art =
          photo([70, 360, 860, 580], rect([70, 360, 860, 580], "white", 290)) +
          (await text([60, 45, 880, 270]));
        break;
      case "c4":
        art =
          photo([130, 200, 740, 600], ellipse([130, 200, 740, 600])) +
          (await text([40, 35, 920, last ? 160 : 200], {
            font: "serif",
            text: first,
            align: "centre",
          })) +
          (last
            ? await text([40, 815, 920, 150], { font: "serif", text: last, align: "centre" })
            : "");
        break;
      case "d1":
        art =
          photo([0, 0, 1000, 460]) +
          (await text([40, 530, 920, 420], {
            font: "condensed",
            text: displayTitle.toUpperCase(),
          }));
        break;
      case "d2":
        for (let i = 0; i < 4; i++) art += await text([280, i * 245, 680, 230], { font: "heavy" });
        art += photo([70, 530, 460, 400]);
        break;
      case "d3":
        art =
          photo() +
          (await text([40, 40, 920, 250], {
            font: "condensed",
            outline: true,
            text: last ? first : displayTitle,
          })) +
          (last ? await text([40, 720, 920, 235], { font: "condensed", text: last }) : "");
        break;
      case "d4":
        art =
          photo() +
          (await text([35, 40, 930, 650], { font: "condensed", text: displayTitle.toUpperCase() }));
        break;
      case "e1":
        art =
          photo([0, 580, 1000, 420]) +
          (await text([50, 40, 900, 500], { font: "heavy", text: split }));
        break;
      case "e2":
        art =
          photo() +
          rotate(
            rect([60, 85, 880, 370], paper) +
              (await text([90, 110, 820, 310], { font: "condensed" })),
            -7,
          );
        break;
      case "e3":
        art =
          photo([300, 370, 650, 580], ellipse([300, 370, 650, 580])) +
          (await text([60, 40, 880, last ? 240 : 310], { font: "serif", text: first })) +
          (last
            ? await text([50, 270, 830, 250], { font: "script", text: last, rotate: -10 })
            : "");
        break;
      case "e4":
        art = photo() + (await text([80, 560, 840, 350], { font: "script", rotate: -8 }));
        break;
      case "f1":
        art =
          photo() +
          rect([180, 120, 640, 750], paper) +
          photo([210, 150, 580, 450], "", 1.35) +
          (await text([230, 625, 540, 200], { font: "script" }));
        break;
      case "f2":
        art = rotate(
          rect([170, 110, 660, 780], "#eee9da") +
            photo([200, 140, 600, 555], "", 1.3) +
            (await text([215, 725, 570, 125], { font: "script" })),
          9,
        );
        break;
      case "f3":
        art =
          photo() +
          photo(
            [0, 0, 580, 1000],
            '<path d="M0 0H550L528 90 580 150 545 220 562 320 510 410 580 520 528 610 550 720 510 800 574 910 545 1000H0Z"/>',
            1.2,
            0.1,
          ) +
          (await text([60, 700, 880, 220], { font: "script", rotate: -8 }));
        break;
      case "f4":
        art =
          photo([0, 290, 1000, 450]) +
          (await text([50, 40, 900, 200], { font: "serif", text: first })) +
          (last
            ? await text([40, 790, 920, 160], { font: "serif", text: last, align: "right" })
            : "");
        break;
      case "g1":
        for (let i = 0; i < 4; i++)
          art += photo([(i % 2) * 510, Math.floor(i / 2) * 510, 490, 490], "", 1.6, i / 3);
        art +=
          rect([30, 425, 940, 175], paper) +
          (await text([50, 445, 900, 135], { font: "condensed", align: "centre" }));
        break;
      case "g2":
        for (let i = 0; i < 5; i++) art += photo([30 + i * 190, 30, 175, 700], "", 1.1, i / 4);
        art += await text([40, 775, 920, 180], { font: "condensed" });
        break;
      case "g3":
        art =
          rotate(rect([75, 80, 555, 490], "#f4f0dc") + photo([95, 100, 515, 450], "", 1.3), -12) +
          rotate(
            rect([420, 140, 500, 460], "#f4f0dc") + photo([440, 160, 460, 420], "", 1.3, 0.8),
            13,
          ) +
          (await text([50, 675, 900, 275]));
        break;
      case "g4":
        art =
          photo([410, 40, 550, 450], "", 1.2) +
          photo([40, 510, 450, 450], "", 2, 0.3) +
          photo([510, 510, 450, 450], "", 1.9, 0.75) +
          (await text([50, 60, 310, 380], { font: "condensed", text: split }));
        break;
      case "h1":
        for (let i = 0; i < 9; i++) {
          const b: Box = [120 + (i % 3) * 260, 260 + Math.floor(i / 3) * 215, 220, 190];
          art += photo(b, ellipse(b), 3, i / 8);
        }
        art += await text([50, 30, 900, 180]);
        break;
      case "h2":
        art =
          photo(
            [70, 290, 860, 620],
            '<path d="M70 290H337V439H638V290H930V507H715V699H930V910H595V755H337V910H70V687H276V501H70Z"/>',
          ) + (await text([60, 40, 880, 210]));
        break;
      case "h3":
        art =
          photo(
            [80, 60, 840, 700],
            '<path d="M500 60L601 172 777 116 785 263 920 319 811 424 886 571 710 599 651 746 492 676 332 760 290 606 105 571 189 424 80 312 240 256 240 109 408 172Z"/>',
          ) + (await text([60, 800, 880, 155], { font: "heavy" }));
        break;
      case "h4":
        art =
          rotate(photo([230, 120, 540, 760], ellipse([230, 120, 540, 760]), 1.4), 32) +
          (await text([40, 30, 920, 200], { font: "serif", text: first })) +
          (last
            ? await text([40, 780, 920, 180], { font: "serif", align: "right", text: last })
            : "");
        break;
      case "i1":
        art = await text([30, 20, 940, 960], {
          font: "condensed",
          text:
            words.length > 1
              ? split
              : Array.from(displayTitle)
                  .reduce<string[]>((lines, letter, index) => {
                    const row = Math.floor(index / Math.ceil(Array.from(displayTitle).length / 2));
                    lines[row] = (lines[row] || "") + letter;
                    return lines;
                  }, [])
                  .join("\n"),
          color: "#ffffff",
          photo: true,
          align: "centre",
        });
        break;
      case "i2":
        art =
          photo() +
          (await text([35, 560, 930, 200], { font: "condensed", outline: true, text: first })) +
          (last ? await text([35, 770, 930, 190], { font: "condensed", text: last }) : "");
        break;
      case "i3":
        art =
          photo([420, 0, 580, 1000]) +
          (await text([30, 35, 350, 920], { font: "condensed", text: split }));
        break;
      case "i4": {
        art = photo([230, 230, 540, 540], ellipse([230, 230, 540, 540]));
        const letters = Array.from(displayTitle);
        const glyphWidth = Math.min(90, 1000 / letters.length);
        for (const start of [-165, 15]) {
          for (const [index, letter] of letters.entries()) {
            if (!letter.trim()) continue;
            const angle = start + ((index + 0.5) * 150) / letters.length;
            const radians = (angle * Math.PI) / 180;
            const x = 500 + Math.cos(radians) * 400;
            const y = 500 + Math.sin(radians) * 400;
            art += rotate(
              await text([x - glyphWidth / 2, y - 50, glyphWidth, 100], {
                text: letter,
                align: "centre",
              }),
              angle + 90,
              x,
              y,
            );
          }
        }
        break;
      }

      case "j1":
        art =
          photo([140, 180, 720, 630]) +
          `<rect x="100" y="100" width="800" height="800" fill="none" stroke="${ink}" stroke-width="4"/><rect x="70" y="130" width="860" height="740" fill="none" stroke="${ink}" stroke-width="4"/>` +
          (await text([50, 25, 900, 190], { font: "serif", text: first })) +
          (last
            ? await text([50, 815, 900, 155], { font: "serif", text: last, align: "right" })
            : "");
        break;
      case "j2":
        art =
          photo([240, 0, 760, 1000]) +
          rotate(await text([40, 390, 920, 170], { font: "condensed" }), -90);
        break;
      case "j3":
        art =
          photo([230, 220, 540, 550], arch([230, 220, 540, 550])) +
          (await text([50, 20, 900, 180], { text: first.toUpperCase() })) +
          (last
            ? await text([50, 805, 900, 165], { text: last.toUpperCase(), align: "right" })
            : "");
        break;
      case "j4":
        for (let i = 0; i < 3; i++) {
          const x = i * 280;
          art += photo(
            [0, 0, 1000, 1000],
            `<path d="M${200 + x} 0H${430 + x}L${230 + x} 1000H${x}Z"/>`,
            1.1,
            i / 2,
          );
        }
        art += await text([40, 690, 920, 220], { font: "condensed", rotate: -9 });
        break;
      case "k1":
        art =
          photo([290, 120, 420, 420], ellipse([290, 120, 420, 420]), 1.45) +
          (await text([50, 600, 900, 315], { font: "serif", align: "centre" }));
        break;
      case "k2":
        art =
          photo([150, 0, 850, 820], '<path d="M150 0H1000V820Z"/>') +
          (await text([60, 630, 880, 315], { font: "heavy" }));
        break;
      case "k3":
        art = photo() + (await text([60, 500, 880, 450], { font: "italic", text: split }));
        break;
      case "k4":
        art =
          photo([250, 310, 720, 660], '<path d="M610 310L970 640 610 970 250 640Z"/>') +
          (await text([40, 35, 920, 200], { text: first })) +
          (last ? await text([40, 245, 920, 200], { text: last, outline: true }) : "");
        break;
    }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="1000" viewBox="0 0 1000 1000">${rect([0, 0, 1000, 1000], paper)}${art}</svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 85 }).toBuffer();
}
