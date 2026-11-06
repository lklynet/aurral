const isEmptyObject = (node) => node.type === "ObjectExpression" && node.properties.length === 0;

const LOOSER_THAN_AND = new Set([
  "ConditionalExpression",
  "AssignmentExpression",
  "SequenceExpression",
  "ArrowFunctionExpression",
  "YieldExpression",
]);

const needsParens = (node) =>
  LOOSER_THAN_AND.has(node.type) || (node.type === "LogicalExpression" && node.operator !== "&&");

const NEGATED = { "==": "!=", "===": "!==", "!=": "==", "!==": "===" };

const negate = (node, text) => {
  if (node.type === "BinaryExpression" && node.operator in NEGATED) {
    return `${text(node.left)} ${NEGATED[node.operator]} ${text(node.right)}`;
  }
  return isSimple(node) ? `!${text(node)}` : `!(${text(node)})`;
};

const isSimple = (node) =>
  ["Identifier", "MemberExpression", "CallExpression", "ChainExpression"].includes(node.type);

export const noEmptyConditionalSpread = {
  meta: {
    type: "suggestion",
    fixable: "code",
    docs: {
      description: "Spread `cond && { ... }` instead of `cond ? { ... } : {}`.",
    },
    messages: {
      emptySpread: "Spread `cond && { ... }` instead of a conditional with an empty object.",
    },
    schema: [],
  },
  create(context) {
    const text = (node) => context.sourceCode.getText(node);
    return {
      SpreadElement(spread) {
        if (spread.parent?.type !== "ObjectExpression") return;
        const conditional = spread.argument;
        if (conditional.type !== "ConditionalExpression") return;
        const { test, consequent, alternate } = conditional;
        const emptyAlternate = isEmptyObject(alternate);
        if (!emptyAlternate && !isEmptyObject(consequent)) return;
        context.report({
          node: conditional,
          messageId: "emptySpread",
          fix(fixer) {
            const value = emptyAlternate ? consequent : alternate;
            const condition = emptyAlternate
              ? needsParens(test)
                ? `(${text(test)})`
                : text(test)
              : negate(test, text);
            const body = needsParens(value) ? `(${text(value)})` : text(value);
            return fixer.replaceText(conditional, `${condition} && ${body}`);
          },
        });
      },
    };
  },
};

export const noChainedTypeAssertion = {
  meta: {
    type: "problem",
    docs: {
      description: "Narrow values instead of asserting through another type.",
    },
    messages: {
      chained: "Narrow the value instead of chaining type assertions.",
    },
    schema: [],
  },
  create(context) {
    return {
      TSAsExpression(node) {
        if (node.expression.type === "TSAsExpression") {
          context.report({ node, messageId: "chained" });
        }
      },
    };
  },
};
