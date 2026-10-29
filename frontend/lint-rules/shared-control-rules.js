function readAttribute(element, name) {
  return element.openingElement.attributes.find(
    (attribute) => attribute.type === "JSXAttribute" && attribute.name.name === name,
  );
}

function readStringValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
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

function collectStaticStrings(node, scope, seen = new Set()) {
  if (!node) return [];
  if (node.type === "Literal" && typeof node.value === "string") return [node.value];
  if (node.type === "JSXText") return [node.value];
  if (node.type === "JSXExpressionContainer")
    return collectStaticStrings(node.expression, scope, seen);

  if (node.type === "TemplateLiteral") {
    return [
      ...node.quasis.map((quasi) => quasi.value.raw),
      ...node.expressions.flatMap((expression) => collectStaticStrings(expression, scope, seen)),
    ];
  }

  if (node.type === "Identifier") {
    if (seen.has(node.name)) return [];
    const initializer = resolveConstantInitializer(node, scope);
    if (!initializer) return [];
    seen.add(node.name);
    return collectStaticStrings(initializer, scope, seen);
  }

  if (node.type === "ConditionalExpression") {
    return [
      ...collectStaticStrings(node.consequent, scope, seen),
      ...collectStaticStrings(node.alternate, scope, seen),
    ];
  }

  if (node.type === "LogicalExpression" || node.type === "BinaryExpression") {
    return [
      ...collectStaticStrings(node.left, scope, seen),
      ...collectStaticStrings(node.right, scope, seen),
    ];
  }

  if (node.type === "JSXElement") {
    return node.children.flatMap((child) => collectStaticStrings(child, scope, seen));
  }

  if (node.type === "ArrayExpression") {
    return node.elements.flatMap((element) => collectStaticStrings(element, scope, seen));
  }

  if (node.type === "CallExpression") {
    return node.arguments.flatMap((argument) => collectStaticStrings(argument, scope, seen));
  }

  return [];
}

function collectClassTokens(attribute, scope) {
  const tokens = new Set();
  if (!attribute) return tokens;

  const value =
    attribute.value?.type === "JSXExpressionContainer"
      ? attribute.value.expression
      : attribute.value;

  const add = (value) => {
    for (const token of value.split(/\s+/).filter(Boolean)) tokens.add(token);
  };

  const visit = (node, seen = new Set()) => {
    if (!node) return;
    const literal =
      node.type === "JSXAttribute" ? readStringValue(node.value) : readStringValue(node);
    if (literal !== null) {
      add(literal);
      return;
    }

    if (node.type === "Identifier") {
      if (seen.has(node.name)) return;
      const initializer = resolveConstantInitializer(node, scope);
      if (initializer) {
        seen.add(node.name);
        visit(initializer, seen);
      }
      return;
    }

    if (node.type === "TemplateLiteral") {
      for (const quasi of node.quasis) add(quasi.value.raw);
      for (const expression of node.expressions) visit(expression, seen);
      return;
    }

    if (node.type === "ConditionalExpression") {
      visit(node.consequent, seen);
      visit(node.alternate, seen);
      return;
    }

    if (node.type === "LogicalExpression") {
      visit(node.left, seen);
      visit(node.right, seen);
      return;
    }

    if (node.type === "ArrayExpression") {
      for (const entry of node.elements) visit(entry, seen);
      return;
    }

    if (node.type === "CallExpression") {
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        ["filter", "join"].includes(node.callee.property.name)
      ) {
        visit(node.callee.object, seen);
      }
      for (const argument of node.arguments) visit(argument, seen);
    }
  };

  visit(value);
  return tokens;
}

function collectGuaranteedClassTokens(attribute, scope) {
  const value =
    attribute?.value?.type === "JSXExpressionContainer"
      ? attribute.value.expression
      : attribute?.value;

  const tokenize = (value) => new Set(value.split(/\s+/).filter(Boolean));
  const intersect = (left, right) => new Set([...left].filter((token) => right.has(token)));

  const collect = (node, seen = new Set()) => {
    if (!node) return new Set();
    if (node.type === "Literal" && typeof node.value === "string") return tokenize(node.value);

    if (node.type === "Identifier") {
      if (seen.has(node.name)) return new Set();
      const initializer = resolveConstantInitializer(node, scope);
      if (!initializer) return new Set();
      const nextSeen = new Set(seen);
      nextSeen.add(node.name);
      return collect(initializer, nextSeen);
    }

    if (node.type === "TemplateLiteral") {
      const tokens = new Set(node.quasis.flatMap((quasi) => [...tokenize(quasi.value.raw)]));
      for (const expression of node.expressions) {
        for (const token of collect(expression, new Set(seen))) tokens.add(token);
      }
      return tokens;
    }

    if (node.type === "ConditionalExpression" || node.type === "LogicalExpression") {
      return intersect(
        collect(node.type === "ConditionalExpression" ? node.consequent : node.left, new Set(seen)),
        collect(node.type === "ConditionalExpression" ? node.alternate : node.right, new Set(seen)),
      );
    }

    if (node.type === "ArrayExpression") {
      return node.elements.reduce((tokens, entry) => {
        for (const token of collect(entry, new Set(seen))) tokens.add(token);
        return tokens;
      }, new Set());
    }

    if (node.type === "CallExpression") {
      if (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        ["filter", "join"].includes(node.callee.property.name)
      ) {
        return collect(node.callee.object, seen);
      }
      return node.arguments.reduce((tokens, argument) => {
        for (const token of collect(argument, new Set(seen))) tokens.add(token);
        return tokens;
      }, new Set());
    }

    return new Set();
  };

  return collect(value);
}

function hasVisibleText(node) {
  if (!node) return false;
  if (node.type === "JSXText") return node.value.trim().length > 0;
  if (node.type === "JSXFragment") return node.children.some(hasVisibleText);

  if (node.type === "JSXElement") {
    const hidden = node.openingElement.attributes.some(
      (attribute) =>
        attribute.type === "JSXAttribute" &&
        ((attribute.name.name === "aria-hidden" && readStringValue(attribute.value) === "true") ||
          (attribute.name.name === "className" &&
            collectStaticStrings(attribute.value, null).some((value) =>
              /(?:^|\s)(?:sr-only|visually-hidden)(?:\s|$)/.test(value),
            ))),
    );
    return !hidden && node.children.some(hasVisibleText);
  }

  if (node.type === "JSXExpressionContainer") return hasVisibleText(node.expression);
  if (node.type === "Literal")
    return typeof node.value === "string" && node.value.trim().length > 0;
  if (node.type === "TemplateLiteral") {
    return (
      node.quasis.some((quasi) => quasi.value.raw.trim().length > 0) || node.expressions.length > 0
    );
  }
  if (node.type === "ConditionalExpression") {
    return hasVisibleText(node.consequent) || hasVisibleText(node.alternate);
  }
  if (node.type === "LogicalExpression") {
    if (node.operator === "&&") return hasVisibleText(node.right);
    if (
      (node.operator === "||" || node.operator === "??") &&
      !hasVisibleText(node.right) &&
      (node.right.type === "JSXElement" || node.right.type === "JSXFragment")
    ) {
      return false;
    }
    return hasVisibleText(node.left) || hasVisibleText(node.right);
  }
  if (node.type === "ArrayExpression") return node.elements.some(hasVisibleText);
  if (
    node.type === "CallExpression" ||
    node.type === "Identifier" ||
    node.type === "MemberExpression" ||
    node.type === "ChainExpression" ||
    node.type === "TaggedTemplateExpression"
  ) {
    return true;
  }
  return false;
}

function isIconOnly(element) {
  return !element.children.some(hasVisibleText);
}

function hasSharedButtonVariant(classTokens) {
  return [...classTokens].some(
    (token) => token.startsWith("btn-") || token.startsWith("btn--") || token === "btn-min-h",
  );
}

function isUnstyled(classNameAttribute) {
  if (!classNameAttribute) return true;

  const value =
    classNameAttribute.value?.type === "JSXExpressionContainer"
      ? classNameAttribute.value.expression
      : classNameAttribute.value;
  return value?.type === "Literal" && typeof value.value === "string" && !value.value.trim();
}

export const sharedControlRules = {
  meta: {
    type: "problem",
    docs: {
      description: "Require Aurral shared button patterns for standard and icon-only actions.",
    },
    messages: {
      standardAction: "Use the shared .btn base class for standard action buttons.",
      iconAction: "Use TooltipButton with a .btn class for icon-only actions.",
      sharedButtonBase: "Add the .btn base class to TooltipButton.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(element) {
        const name = element.openingElement.name;
        if (name.type !== "JSXIdentifier") return;

        const isNativeButton = name.name === "button";
        const isTooltipButton = name.name === "TooltipButton";
        if (!isNativeButton && !isTooltipButton) return;

        const scope = context.sourceCode.getScope(element);
        const classNameAttribute = readAttribute(element, "className");
        const classTokens = collectClassTokens(classNameAttribute, scope);
        const guaranteedClassTokens = collectGuaranteedClassTokens(classNameAttribute, scope);

        if (isNativeButton) {
          const role = collectStaticStrings(readAttribute(element, "role")?.value, scope)[0];
          if (role === "menuitem" || role === "switch") return;

          const iconOnly = isIconOnly(element);
          const unstyled = isUnstyled(classNameAttribute);
          const usesSharedVariant = hasSharedButtonVariant(classTokens);

          if (iconOnly && (unstyled || usesSharedVariant)) {
            context.report({ node: element.openingElement, messageId: "iconAction" });
            return;
          }

          if (unstyled || (usesSharedVariant && !guaranteedClassTokens.has("btn"))) {
            context.report({ node: element.openingElement, messageId: "standardAction" });
          }
          return;
        }

        if (
          !guaranteedClassTokens.has("btn") &&
          (isUnstyled(classNameAttribute) || hasSharedButtonVariant(classTokens))
        ) {
          context.report({ node: element.openingElement, messageId: "sharedButtonBase" });
        }
      },
    };
  },
};
