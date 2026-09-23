import {
  getClosestToken,
  getSuggestedToken,
  hasStaticColor,
  isColorBearingProperty,
  runtimeAurralGeometryProperties,
} from "../scripts/lint-ui-css.mjs";

const artworkColorNames = new Set([
  "artworkColor",
  "coverColor",
  "dominantColor",
  "extractedColor",
  "imageColor",
]);

function toCssProperty(property) {
  return property.startsWith("--")
    ? property
    : property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function readPropertyName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function getTokenNames(context) {
  return new Set(context.options[0]?.tokenNames ?? []);
}

function resolveConstantInitializer(identifier, scope) {
  if (identifier.type !== "Identifier") return null;

  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(identifier.name);
    if (!variable) continue;

    const definition = variable.defs.find(
      (entry) => entry.type === "Variable" && entry.node.type === "VariableDeclarator",
    );
    if (definition?.parent?.kind !== "const") return null;
    return definition.node.init;
  }

  return null;
}

function collectStyleObjects(expression, scope, seen = new Set()) {
  if (!expression) return [];
  if (expression.type === "ObjectExpression") return [expression];

  if (expression.type === "Identifier") {
    if (seen.has(expression.name)) return [];
    const initializer = resolveConstantInitializer(expression, scope);
    if (!initializer) return [];
    seen.add(expression.name);
    return collectStyleObjects(initializer, scope, seen);
  }

  if (expression.type === "ConditionalExpression") {
    return [
      ...collectStyleObjects(expression.consequent, scope, seen),
      ...collectStyleObjects(expression.alternate, scope, seen),
    ];
  }

  if (expression.type === "LogicalExpression") {
    return [
      ...collectStyleObjects(expression.left, scope, seen),
      ...collectStyleObjects(expression.right, scope, seen),
    ];
  }

  return [];
}

function collectStaticStrings(expression, scope, seen = new Set()) {
  if (!expression) return [];

  if (expression.type === "Literal" && typeof expression.value === "string") {
    return [{ node: expression, value: expression.value }];
  }

  if (expression.type === "TemplateLiteral") {
    if (expression.expressions.length === 0) {
      return [{ node: expression.quasis[0], value: expression.quasis[0].value.raw }];
    }

    return expression.expressions.flatMap((part) => collectStaticStrings(part, scope, seen));
  }

  if (expression.type === "Identifier") {
    if (seen.has(expression.name)) return [];
    const initializer = resolveConstantInitializer(expression, scope);
    if (!initializer) return [];
    seen.add(expression.name);
    return collectStaticStrings(initializer, scope, seen);
  }

  if (expression.type === "MemberExpression") {
    const object = resolveConstantInitializer(expression.object, scope);
    if (object?.type !== "ObjectExpression") return [];

    const propertyName = expression.computed
      ? expression.property.type === "Literal" && typeof expression.property.value === "string"
        ? expression.property.value
        : null
      : expression.property.name;
    if (!propertyName) return [];

    const property = object.properties.find(
      (entry) => entry.type === "Property" && readPropertyName(entry.key) === propertyName,
    );
    return property ? collectStaticStrings(property.value, scope, seen) : [];
  }

  if (expression.type === "ChainExpression") {
    return collectStaticStrings(expression.expression, scope, seen);
  }

  if (expression.type === "ConditionalExpression") {
    return [
      ...collectStaticStrings(expression.consequent, scope, seen),
      ...collectStaticStrings(expression.alternate, scope, seen),
    ];
  }

  if (expression.type === "LogicalExpression" || expression.type === "BinaryExpression") {
    return [
      ...collectStaticStrings(expression.left, scope, seen),
      ...collectStaticStrings(expression.right, scope, seen),
    ];
  }

  if (expression.type === "UnaryExpression") {
    return collectStaticStrings(expression.argument, scope, seen);
  }

  if (expression.type === "CallExpression" || expression.type === "NewExpression") {
    return expression.arguments.flatMap((argument) =>
      collectStaticStrings(argument, scope, seen),
    );
  }

  if (expression.type === "ArrayExpression") {
    return expression.elements.flatMap((element) => collectStaticStrings(element, scope, seen));
  }

  if (expression.type === "SequenceExpression") {
    return expression.expressions.flatMap((part) => collectStaticStrings(part, scope, seen));
  }

  return [];
}

function includesArtworkColorReference(expression) {
  if (!expression) return false;
  if (expression.type === "Identifier") return artworkColorNames.has(expression.name);
  if (expression.type === "MemberExpression") {
    return artworkColorNames.has(expression.computed ? expression.property.value : expression.property.name);
  }
  if (expression.type === "ChainExpression") return includesArtworkColorReference(expression.expression);
  if (expression.type === "LogicalExpression") {
    return (
      includesArtworkColorReference(expression.left) ||
      includesArtworkColorReference(expression.right)
    );
  }
  return false;
}

function collectArtworkFallbackNodes(property, expression, scope, seen = new Set()) {
  if (
    !expression ||
    (!property.startsWith("--") && !isColorBearingProperty(property))
  ) {
    return new Set();
  }

  if (expression.type === "Identifier") {
    if (seen.has(expression.name)) return new Set();
    const initializer = resolveConstantInitializer(expression, scope);
    if (!initializer) return new Set();
    seen.add(expression.name);
    return collectArtworkFallbackNodes(property, initializer, scope, seen);
  }

  if (expression.type === "ChainExpression") {
    return collectArtworkFallbackNodes(property, expression.expression, scope, seen);
  }

  if (expression.type === "LogicalExpression") {
    const fallback =
      ["||", "??"].includes(expression.operator) &&
      expression.right.type === "Literal" &&
      typeof expression.right.value === "string" &&
      includesArtworkColorReference(expression.left) &&
      hasStaticColor(expression.right.value)
        ? new Set([expression.right])
        : new Set();

    for (const child of [expression.left, expression.right]) {
      for (const node of collectArtworkFallbackNodes(property, child, scope, seen)) {
        fallback.add(node);
      }
    }
    return fallback;
  }

  if (expression.type === "ConditionalExpression") {
    return new Set([
      ...collectArtworkFallbackNodes(property, expression.consequent, scope, seen),
      ...collectArtworkFallbackNodes(property, expression.alternate, scope, seen),
    ]);
  }

  if (expression.type === "CallExpression" || expression.type === "NewExpression") {
    return new Set(
      expression.arguments.flatMap((argument) =>
        [...collectArtworkFallbackNodes(property, argument, scope, seen)],
      ),
    );
  }

  return new Set();
}

function collectObjectProperties(objects, scope) {
  const properties = [];
  const visited = new Set();

  const visit = (object) => {
    if (visited.has(object)) return;
    visited.add(object);

    for (const property of object.properties) {
      if (property.type === "Property") {
        properties.push(property);
      } else if (property.type === "SpreadElement") {
        for (const nested of collectStyleObjects(property.argument, scope)) visit(nested);
      }
    }
  };

  for (const object of objects) {
    visit(object);
  }

  return properties;
}

function createStyleRule({ messages, analyze }) {
  return {
    meta: {
      type: "problem",
      docs: { description: messages.description },
      messages: messages.messages,
      schema: [
        {
          type: "object",
          properties: {
            tokenNames: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      const tokenNames = getTokenNames(context);

      return {
        JSXAttribute(attribute) {
          if (
            attribute.name.name !== "style" ||
            attribute.value?.type !== "JSXExpressionContainer"
          ) {
            return;
          }

          const scope = context.sourceCode.getScope(attribute);
          const objects = collectStyleObjects(attribute.value.expression, scope);
          const properties = collectObjectProperties(objects, scope);

          for (const property of properties) {
            const name = readPropertyName(property.key);
            if (!name) continue;

            const cssProperty = toCssProperty(name);
            analyze({
              context,
              property,
              cssProperty,
              tokenNames,
              objects,
              scope,
            });
          }
        },
      };
    },
  };
}

export const noHardCodedStyleColor = createStyleRule({
  messages: {
    description: "Require Aurral semantic tokens for static theme colors in JSX style props.",
    messages: {
      hardcoded:
        "Hard-coded color in JSX style property '{{property}}'; use var({{token}}) when this is Aurral theme styling.",
      hardcodedWithoutToken:
        "Hard-coded color in JSX style property '{{property}}'; use an existing Aurral semantic token when this is theme styling.",
    },
  },
  analyze({ context, property, cssProperty, tokenNames, scope }) {
    const isColorProperty = cssProperty.startsWith("--") || isColorBearingProperty(cssProperty);
    if (!isColorProperty) return;

            const suggestion =
      getSuggestedToken(cssProperty, tokenNames) ||
      (tokenNames.has("--aurral-text") ? "--aurral-text" : null);
    const staticStrings = collectStaticStrings(property.value, scope);
    const artworkFallbacks = collectArtworkFallbackNodes(cssProperty, property.value, scope);

    for (const entry of staticStrings) {
      if (artworkFallbacks.has(entry.node) || !hasStaticColor(entry.value)) continue;

      const propertySuggestion = cssProperty.startsWith("--") ? null : suggestion;
      context.report({
        node: entry.node,
        messageId: propertySuggestion ? "hardcoded" : "hardcodedWithoutToken",
        data: {
          property: cssProperty,
          token: propertySuggestion,
        },
      });
    }
  },
});

export const noUndefinedStyleToken = createStyleRule({
  messages: {
    description: "Reject JSX style references to undefined Aurral tokens.",
    messages: {
      undefined:
        "Undefined Aurral token {{token}} in JSX style; use var({{suggestion}}) or add the token to frontend/src/index.css.",
      undefinedWithoutSuggestion:
        "Undefined Aurral token {{token}} in JSX style; add it to frontend/src/index.css or use an existing Aurral token.",
    },
  },
  analyze({ context, property, tokenNames, scope }) {
    for (const entry of collectStaticStrings(property.value, scope)) {
      const references = new Set(
        [...entry.value.matchAll(/\bvar\(\s*(--aurral-[\w-]+)/g)].map((match) => match[1]),
      );

      for (const reference of references) {
        if (tokenNames.has(reference) || runtimeAurralGeometryProperties.has(reference)) continue;

        const suggestion = getClosestToken(reference, tokenNames);
        context.report({
          node: entry.node,
          messageId: suggestion ? "undefined" : "undefinedWithoutSuggestion",
          data: {
            token: reference,
            suggestion,
          },
        });
      }
    }
  },
});
