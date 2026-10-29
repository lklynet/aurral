import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";
import type { AtRule, Container, Declaration, Document, Rule } from "postcss";

import { asAppError } from "../../lib/errors.ts";
import { readAurralTokens } from "./ui-token-source.mts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceDirectory = path.join(repositoryRoot, "frontend/src");

const colorBearingProperties = new Set([
  "accent-color",
  "background",
  "background-color",
  "background-image",
  "border",
  "box-shadow",
  "caret-color",
  "column-rule-color",
  "color",
  "fill",
  "filter",
  "flood-color",
  "lighting-color",
  "outline",
  "outline-color",
  "stop-color",
  "stroke",
  "text-decoration-color",
  "text-shadow",
]);

const colorKeywords = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
   brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue
   darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange
   darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise
   darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia
   gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo
   ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
   lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue
   lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon
   mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
   mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
   navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
   paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
   rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
   slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
   whitesmoke yellow yellowgreen`.split(/\s+/),
);

const colorFunctionPattern =
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|light-dark|device-cmyk)\s*\(/i;
const hexColorPattern = /#[\da-f]{3,8}\b/i;
const propertySuggestions: [RegExp, string][] = [
  [
    /^(?:color|text-decoration-color|fill|stroke|caret-color|flood-color|lighting-color|stop-color)$/,
    "--aurral-text",
  ],
  [/^(?:background|background-color|background-image)$/, "--aurral-surface"],
  [/^border(?:-.+)?$/, "--aurral-border"],
  [/^outline(?:-.+)?$/, "--aurral-ring"],
  [/^(?:box-shadow|text-shadow|filter)$/, "--aurral-shadow-popover"],
  [/^(?:accent-color|column-rule-color)$/, "--aurral-accent"],
];

function isRootTokenSelector(selector: string) {
  return selector.split(",").some((part) => {
    const trimmed = part.trim();
    return trimmed === ":root" || /^:root(?:\[|:not\()/.test(trimmed);
  });
}

function isAurralTokenDefinition(declaration: Declaration) {
  return (
    declaration.prop.startsWith("--aurral-") &&
    declaration.parent?.type === "rule" &&
    isRootTokenSelector(declaration.parent.selector)
  );
}

export function hasStaticColor(value: string) {
  const withoutUrlsAndComments = value
    .replace(/url\([^)]*\)/gi, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  if (
    hexColorPattern.test(withoutUrlsAndComments) ||
    colorFunctionPattern.test(withoutUrlsAndComments)
  ) {
    return true;
  }

  return (
    withoutUrlsAndComments
      .toLowerCase()
      .match(/(?<![\w-])[a-z]+(?![\w-])/g)
      ?.some((word) => colorKeywords.has(word)) ?? false
  );
}

export function isColorBearingProperty(property: string) {
  return colorBearingProperties.has(property) || property.startsWith("border");
}

export function getSuggestedToken(property: string, tokenNames: Set<string>) {
  const entry = propertySuggestions.find(([pattern]) => pattern.test(property));
  if (entry && tokenNames.has(entry[1])) return entry[1];
  return null;
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + substitutionCost,
      );
      diagonal = above;
    }
  }

  return previous[right.length];
}

export function getClosestToken(name: string, tokenNames: Set<string>) {
  let closest = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const token of tokenNames) {
    const distance = editDistance(name, token);
    if (distance < closestDistance) {
      closest = token;
      closestDistance = distance;
    }
  }

  return closest && closestDistance <= 2 ? closest : null;
}

const motionProperties =
  /^(?:transition|transition-duration|transition-timing-function|transition-delay|animation|animation-duration|animation-timing-function)$/;
const rawEasingPattern =
  /(?<![\w-])(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)(?![\w-])|\b(?:cubic-bezier|steps|linear)\s*\(/i;
const rawDurationPattern = /(?<![\w.#-])-?\d*\.?\d+m?s(?![\w-])/gi;
const allowedDurations = new Set(["0s", "0ms", "0.01ms"]);

export function findRawMotion(property: string, value: string) {
  if (!motionProperties.test(property)) return null;
  const withoutVariables = value.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "");
  if (rawEasingPattern.test(withoutVariables)) return "easing";
  const looping = property.startsWith("animation") && /\binfinite\b/i.test(value);
  if (looping) return null;
  const durations = withoutVariables.match(rawDurationPattern) ?? [];
  return durations.some((duration) => !allowedDurations.has(duration.toLowerCase()))
    ? "duration"
    : null;
}

const fontWeights = new Set(["400", "500", "600", "700", "inherit"]);
const loopingAnimations = new Set([
  "track-playing-bar",
  "track-playing-pulse",
  "aurral-dot-loader-helix",
  "aurral-dot-loader-pulse",
]);
const radiusProperty = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;

function withoutTokens(value: string, prefix: string) {
  const token = String.raw`var\(\s*${prefix}[\w-]*\s*\)`;
  return value
    .replace(new RegExp(String.raw`calc\([^()]*${token}[^()]*\)`, "g"), "")
    .replace(new RegExp(token, "g"), "");
}

export function findTypeOrShapeIssue(property: string, value: string) {
  const trimmed = value
    .replace(/\s*!important\s*$/i, "")
    .trim()
    .toLowerCase();
  if (
    property === "font-size" &&
    trimmed !== "inherit" &&
    !trimmed.includes("var(--aurral-font-")
  ) {
    return "uses a raw font-size; use a --aurral-font-* step.";
  }
  if (property === "font-weight" && !fontWeights.has(trimmed)) {
    return "uses a font-weight outside 400, 500, 600, and 700.";
  }
  if (property === "font-family" && !/^(?:inherit|var\(--font-(?:sans|mono)\))$/.test(trimmed)) {
    return "uses a raw font-family; use var(--font-sans) or var(--font-mono).";
  }
  if (
    property === "letter-spacing" &&
    !/^(?:0|normal|inherit|var\(--aurral-tracking-[\w-]+\))$/.test(trimmed)
  ) {
    return "uses raw letter-spacing; use 0 or a --aurral-tracking-* token.";
  }
  if (
    radiusProperty.test(property) &&
    withoutTokens(trimmed, "--aurral-radius")
      .replace(/(?<![\w.])0(?![\w.%])|50%|inherit|\//g, "")
      .trim()
  ) {
    return "uses a raw radius; use 0, 50%, or a --aurral-radius-* token.";
  }
  if (property === "animation" || property === "animation-iteration-count") {
    if (!/\binfinite\b/.test(trimmed)) return null;
    const names = trimmed.split(",").map((part) => part.trim().split(/\s+/)[0]);
    if (property === "animation" && names.every((name) => loopingAnimations.has(name))) return null;
    return "loops an animation forever; looping motion repaints every frame, so keep it to the playback and loader exceptions.";
  }
  return null;
}

const zIndexKeywords = new Set(["auto", "inherit", "initial", "unset", "revert", "revert-layer"]);

export function hasRawZIndex(value: string) {
  const trimmed = value.trim().toLowerCase();
  return !zIndexKeywords.has(trimmed) && !/var\(\s*--aurral-z-[\w-]+/.test(trimmed);
}

export function hasStaticViewportHeight(value: string) {
  return /(?<![\w.-])\d*\.?\d+vh\b/i.test(value);
}

function isInsideHoverMedia(node: Rule) {
  for (let parent: Container | Document | undefined = node.parent; parent; parent = parent.parent) {
    if (
      parent.type === "atrule" &&
      (parent as AtRule).name === "media" &&
      /\(\s*hover\s*:\s*hover\s*\)/.test((parent as AtRule).params)
    ) {
      return true;
    }
  }
  return false;
}

function sourceLine(declaration: Declaration) {
  return declaration.source?.start?.line ?? 1;
}

function createFinding(
  filePath: string,
  line: number,
  ruleId: string,
  message: string,
  suggestion: string | null = null,
) {
  return { filePath, line, ruleId, suggestion, message: `${filePath}:${line} ${message}` };
}

type CssFinding = ReturnType<typeof createFinding>;

export function lintCss(
  css: string,
  {
    filePath = "<input>",
    tokenNames = new Set<string>(),
  }: { filePath?: string; tokenNames?: Set<string> } = {},
) {
  let root;

  try {
    root = postcss.parse(css, { from: filePath });
  } catch (error) {
    const syntaxError = error instanceof postcss.CssSyntaxError ? error : undefined;
    const failure = asAppError(error);
    const line = syntaxError?.line ?? 1;
    return [
      createFinding(
        filePath,
        line,
        "aurral/css-parse-error",
        `could not parse stylesheet: ${syntaxError?.reason || failure?.message}`,
      ),
    ];
  }

  const findings: CssFinding[] = [];
  const localPropertySuggestions = new Map<string, string>();

  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) return;

    const suggestion = getSuggestedToken(declaration.prop.toLowerCase(), tokenNames);
    if (!suggestion) return;

    for (const match of declaration.value.matchAll(/\bvar\(\s*(--[\w-]+)/g)) {
      if (!match[1].startsWith("--aurral-")) {
        localPropertySuggestions.set(match[1], suggestion);
      }
    }
  });

  root.walkDecls((declaration) => {
    const line = sourceLine(declaration);
    const references = new Set(
      [...declaration.value.matchAll(/\bvar\(\s*(--aurral-[\w-]+)/g)].map((match) => match[1]),
    );

    for (const reference of references) {
      if (tokenNames.has(reference)) continue;

      const suggestion = getClosestToken(reference, tokenNames);
      const correction = suggestion
        ? `use var(${suggestion})`
        : "add it to frontend/src/index.css or use an existing Aurral token";
      findings.push(
        createFinding(
          filePath,
          line,
          "aurral/no-undefined-token",
          `uses undefined Aurral token ${reference}; ${correction}.`,
          suggestion,
        ),
      );
    }

    if (isAurralTokenDefinition(declaration)) return;

    const property = declaration.prop.toLowerCase();
    if (hasStaticViewportHeight(declaration.value)) {
      findings.push(
        createFinding(
          filePath,
          line,
          "aurral/no-vh",
          "uses vh, which ignores mobile browser toolbars; use dvh.",
        ),
      );
    }

    if (property === "z-index" && hasRawZIndex(declaration.value)) {
      findings.push(
        createFinding(
          filePath,
          line,
          "aurral/no-raw-z-index",
          "uses a raw z-index; use a --aurral-z-* layer token.",
        ),
      );
    }

    const typeOrShapeIssue = property.startsWith("--")
      ? null
      : findTypeOrShapeIssue(property, declaration.value);
    if (typeOrShapeIssue) {
      findings.push(createFinding(filePath, line, "aurral/design-scale", typeOrShapeIssue));
    }

    const rawMotion = findRawMotion(property, declaration.value);
    if (rawMotion) {
      findings.push(
        createFinding(
          filePath,
          line,
          "aurral/no-raw-motion",
          `uses a raw ${rawMotion} in ${property}; use the --aurral-duration-* and --aurral-ease-* tokens.`,
        ),
      );
    }

    const isCustomProperty = property.startsWith("--");
    if (!isCustomProperty && !isColorBearingProperty(property)) return;
    if (!hasStaticColor(declaration.value)) return;

    const suggestion = isCustomProperty
      ? (localPropertySuggestions.get(property) ?? null)
      : getSuggestedToken(property, tokenNames);
    const correction = suggestion
      ? `use var(${suggestion}) when this is Aurral theme styling.`
      : "use an existing Aurral semantic token when this is theme styling.";
    findings.push(
      createFinding(
        filePath,
        line,
        "aurral/no-hard-coded-color",
        `contains a hard-coded color in ${property}; ${correction}`,
        suggestion,
      ),
    );
  });

  root.walkRules((rule) => {
    if (!rule.selector.includes(":hover") || isInsideHoverMedia(rule)) return;
    findings.push(
      createFinding(
        filePath,
        rule.source?.start?.line ?? 1,
        "aurral/no-ungated-hover",
        "styles :hover outside @media (hover: hover) and (pointer: fine), so the style sticks after a tap on touch screens.",
      ),
    );
  });

  return findings;
}

async function findCssFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findCssFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".css") ? [entryPath] : [];
    }),
  );

  return nested.flat();
}

export async function lintUiCss(directory = sourceDirectory) {
  const tokenSource = await readAurralTokens();
  const tokenNames = new Set(tokenSource.declarations.map(({ name }) => name));
  const cssFiles = await findCssFiles(directory);
  const findings = [];

  for (const filePath of cssFiles) {
    const css = await readFile(filePath, "utf8");
    findings.push(
      ...lintCss(css, {
        filePath: path.relative(repositoryRoot, filePath).split(path.sep).join("/"),
        tokenNames,
      }),
    );
  }

  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const findings = await lintUiCss();
    for (const finding of findings) console.error(`${finding.message} [${finding.ruleId}]`);
    if (findings.length > 0) {
      console.error(`Found ${findings.length} Aurral CSS design-system issue(s).`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(asAppError(error)?.message);
    process.exitCode = 1;
  }
}
