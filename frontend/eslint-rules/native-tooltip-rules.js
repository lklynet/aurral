function isNativeElementName(name) {
  return name.type === "JSXIdentifier" && /^[a-z]/.test(name.name);
}

function hasAttribute(element, attributeName) {
  return element.openingElement.attributes.some(
    (attribute) =>
      attribute.type === "JSXAttribute" && attribute.name.name === attributeName,
  );
}

export const noNativeTooltipRules = {
  meta: {
    type: "problem",
    docs: {
      description: "Require Aurral tooltip components instead of native title tooltips.",
    },
    messages: {
      nativeTitle:
        "Native title tooltips are not allowed. Use Aurral Tooltip or TooltipButton instead.",
      missingContent: "Aurral Tooltip requires a content prop.",
      missingLabel: "Aurral TooltipButton requires a label or title prop.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(element) {
        const name = element.openingElement.name;
        if (name.type !== "JSXIdentifier") return;

        if (isNativeElementName(name) && name.name !== "iframe" && hasAttribute(element, "title")) {
          context.report({ node: element.openingElement, messageId: "nativeTitle" });
          return;
        }

        if (name.name === "Tooltip" && !hasAttribute(element, "content")) {
          context.report({ node: element.openingElement, messageId: "missingContent" });
        }

        if (
          name.name === "TooltipButton" &&
          !hasAttribute(element, "label") &&
          !hasAttribute(element, "title")
        ) {
          context.report({ node: element.openingElement, messageId: "missingLabel" });
        }
      },
    };
  },
};
