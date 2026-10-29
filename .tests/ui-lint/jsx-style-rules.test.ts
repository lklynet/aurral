import { test } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";

import {
  noHardCodedStyleColor,
  noUndefinedStyleToken,
} from "../../frontend/lint-rules/ui-style-rules.js";

const tokenNames = [
  "--aurral-accent",
  "--aurral-border",
  "--aurral-ring",
  "--aurral-surface",
  "--aurral-text",
  "--aurral-text-subtle",
];

const tokenOptions = [{ tokenNames }];
const tester = new RuleTester({
  languageOptions: {
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

test("Aurral JSX style color rule allows tokens and dynamic values", () => {
  tester.run(
    "aurral/no-hard-coded-color",
    noHardCodedStyleColor as Parameters<typeof tester.run>[1],
    {
      valid: [
        {
          code: 'const view = <div style={{ color: "var(--aurral-text)" }} />;',
          options: tokenOptions,
        },
        {
          code: "const view = <div style={{ width: `${progress}%`, color: labelColor }} />;",
          options: tokenOptions,
        },
        {
          code: "const view = <div style={{ backgroundColor: `rgb(${red}, ${green}, ${blue})` }} />;",
          options: tokenOptions,
        },
      ],
      invalid: [
        {
          code: 'const view = <div style={{ color: "#fff" }} />;',
          options: tokenOptions,
          errors: [
            {
              messageId: "hardcoded",
              data: { property: "color", token: "--aurral-text" },
            },
          ],
        },
        {
          code: 'const view = <div style={{ color: themeColor || "white" }} />;',
          options: tokenOptions,
          errors: [
            {
              messageId: "hardcoded",
              data: { property: "color", token: "--aurral-text" },
            },
          ],
        },
        {
          code: 'const style = { color: "#fff" }; const view = <div style={style} />;',
          options: tokenOptions,
          errors: [
            {
              messageId: "hardcoded",
              data: { property: "color", token: "--aurral-text" },
            },
          ],
        },
      ],
    },
  );
});

test("Aurral JSX style token rule reports unknown references and allows runtime geometry", () => {
  tester.run(
    "aurral/no-undefined-token",
    noUndefinedStyleToken as Parameters<typeof tester.run>[1],
    {
      valid: [
        {
          code: 'const view = <div style={{ color: "var(--aurral-text)" }} />;',
          options: tokenOptions,
        },
      ],
      invalid: [
        {
          code: 'const view = <div style={{ color: "var(--aurral-text-sublte)" }} />;',
          options: tokenOptions,
          errors: [
            {
              messageId: "undefined",
              data: { token: "--aurral-text-sublte", suggestion: "--aurral-text-subtle" },
            },
          ],
        },
        {
          code: 'const view = <div style={{ color: themeColor || "var(--aurral-acccent)" }} />;',
          options: tokenOptions,
          errors: [
            {
              messageId: "undefined",
              data: { token: "--aurral-acccent", suggestion: "--aurral-accent" },
            },
          ],
        },
      ],
    },
  );
});
