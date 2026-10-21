export const singleMainRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Keep the page's only <main> in Layout.",
    },
    messages: {
      extraMain: "Layout renders the page's only <main>. Use a <div> or <section> for page roots.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(element) {
        if (element.name.type === "JSXIdentifier" && element.name.name === "main") {
          context.report({ node: element, messageId: "extraMain" });
        }
      },
    };
  },
};
