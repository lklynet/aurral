import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postcss from "postcss";

import { asAppError } from "../../lib/errors.ts";

const defaultTokenSource = fileURLToPath(new URL("../src/index.css", import.meta.url));

type AurralTokenDeclaration = { name: string; selector: string; value: string };

function isRootSelector(selector: string) {
  return selector.split(",").some((part) => {
    const trimmed = part.trim();
    return trimmed === ":root" || /^:root(?:\[|:not\()/.test(trimmed);
  });
}

export function parseAurralTokens(css: string, source = "<input>") {
  let root;

  try {
    root = postcss.parse(css, { from: source });
  } catch (error) {
    throw new Error(
      `Unable to parse Aurral token source at "${source}": ${asAppError(error)?.message}`,
      {
        cause: error,
      },
    );
  }

  const declarations: AurralTokenDeclaration[] = [];
  const references = new Set();

  root.walkRules((rule) => {
    if (!isRootSelector(rule.selector)) return;

    for (const node of rule.nodes ?? []) {
      if (node.type !== "decl" || !node.prop.startsWith("--aurral-")) continue;

      declarations.push({
        name: node.prop,
        selector: rule.selector,
        value: node.value,
      });
    }
  });

  root.walkDecls((declaration) => {
    for (const match of declaration.value.matchAll(/\bvar\(\s*(--aurral-[\w-]+)/g)) {
      references.add(match[1]);
    }
  });

  return { declarations, references };
}

export async function readAurralTokens(source = defaultTokenSource) {
  let css;

  try {
    css = await readFile(source, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read Aurral token source at "${source}": ${asAppError(error)?.message}`,
      {
        cause: error,
      },
    );
  }

  return parseAurralTokens(css, source);
}
