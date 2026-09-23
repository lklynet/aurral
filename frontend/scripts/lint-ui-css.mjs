import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";

import { readAurralTokens } from "./ui-token-source.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceDirectory = path.join(repositoryRoot, "frontend/src");
export const runtimeAurralGeometryProperties = new Set([
  "--aurral-dot-loader-tile-size",
  "--aurral-dot-loader-gap",
]);

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

const colorFunctionPattern = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|light-dark|device-cmyk)\s*\(/i;
const hexColorPattern = /#[\da-f]{3,8}\b/i;
const propertySuggestions = [
  [/^(?:color|text-decoration-color|fill|stroke|caret-color|flood-color|lighting-color|stop-color)$/, "--aurral-text"],
  [/^(?:background|background-color|background-image)$/, "--aurral-surface"],
  [/^border(?:-.+)?$/, "--aurral-border"],
  [/^outline(?:-.+)?$/, "--aurral-ring"],
  [/^(?:box-shadow|text-shadow|filter)$/, "--aurral-shadow-popover"],
  [/^(?:accent-color|column-rule-color)$/, "--aurral-accent"],
];

function isRootTokenSelector(selector) {
  return selector.split(",").some((part) => {
    const trimmed = part.trim();
    return trimmed === ":root" || /^:root(?:\[|:not\()/.test(trimmed);
  });
}

function isAurralTokenDefinition(declaration) {
  return (
    declaration.prop.startsWith("--aurral-") &&
    declaration.parent?.type === "rule" &&
    isRootTokenSelector(declaration.parent.selector)
  );
}

export function hasStaticColor(value) {
  const withoutUrlsAndComments = value
    .replace(/url\([^)]*\)/gi, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  if (hexColorPattern.test(withoutUrlsAndComments) || colorFunctionPattern.test(withoutUrlsAndComments)) {
    return true;
  }

  return withoutUrlsAndComments
    .toLowerCase()
    .match(/(?<![\w-])[a-z]+(?![\w-])/g)
    ?.some((word) => colorKeywords.has(word)) ?? false;
}

export function isColorBearingProperty(property) {
  return colorBearingProperties.has(property) || property.startsWith("border");
}

export function getSuggestedToken(property, tokenNames) {
  const entry = propertySuggestions.find(([pattern]) => pattern.test(property));
  if (entry && tokenNames.has(entry[1])) return entry[1];
  return null;
}

function editDistance(left, right) {
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

export function getClosestToken(name, tokenNames) {
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

function sourceLine(declaration) {
  return declaration.source?.start?.line ?? 1;
}

function createFinding(filePath, line, ruleId, message, suggestion = null) {
  return { filePath, line, ruleId, suggestion, message: `${filePath}:${line} ${message}` };
}

export function lintCss(css, { filePath = "<input>", tokenNames = new Set() } = {}) {
  let root;

  try {
    root = postcss.parse(css, { from: filePath });
  } catch (error) {
    const line = error.line ?? 1;
    return [
      createFinding(
        filePath,
        line,
        "aurral/css-parse-error",
        `could not parse stylesheet: ${error.reason || error.message}`,
      ),
    ];
  }

  const findings = [];
  const localPropertySuggestions = new Map();

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
      if (tokenNames.has(reference) || runtimeAurralGeometryProperties.has(reference)) continue;

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
    const isCustomProperty = property.startsWith("--");
    if (!isCustomProperty && !isColorBearingProperty(property)) return;
    if (!hasStaticColor(declaration.value)) return;

    const suggestion = isCustomProperty
      ? localPropertySuggestions.get(property) ?? null
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

  return findings;
}

async function findCssFiles(directory) {
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
    console.error(error.message);
    process.exitCode = 1;
  }
}
