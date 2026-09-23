import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import { readFile } from "node:fs/promises";
import { readAurralTokens } from "./scripts/ui-token-source.mjs";
import {
  noHardCodedStyleColor,
  noUndefinedStyleToken,
} from "./eslint-rules/ui-style-rules.js";
import { sharedControlRules } from "./eslint-rules/shared-control-rules.js";
import { noNativeTooltipRules } from "./eslint-rules/native-tooltip-rules.js";

const [tokenSource, exceptionSource] = await Promise.all([
  readAurralTokens(),
  readFile(new URL("./eslint-rules/shared-control-exceptions.json", import.meta.url), "utf8"),
]);
const tokenNames = tokenSource.declarations.map(({ name }) => name);
const sharedControlExceptions = JSON.parse(exceptionSource);

export default [
  {
    ignores: ["dist", "node_modules", "eslint.config.js"],
  },
  {
    files: ["src/**/*.js", "src/**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    settings: { react: { version: "18.2" } },
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...(react.configs["jsx-runtime"]?.rules || {}),
      ...reactHooks.configs.recommended.rules,
      "react/jsx-no-target-blank": "off",
      "react/prop-types": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unexpected-multiline": "off",
      "no-unused-vars": [
        "error",
        { caughtErrors: "none", argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.js", "src/**/*.jsx"],
    plugins: {
      aurral: {
        rules: {
          "no-hard-coded-style-color": noHardCodedStyleColor,
          "no-undefined-style-token": noUndefinedStyleToken,
          "shared-control-patterns": sharedControlRules,
          "no-native-tooltip": noNativeTooltipRules,
        },
      },
    },
    rules: {
      "aurral/no-hard-coded-style-color": ["error", { tokenNames }],
      "aurral/no-undefined-style-token": ["error", { tokenNames }],
      "aurral/shared-control-patterns": ["error", { exceptions: sharedControlExceptions }],
      "aurral/no-native-tooltip": "error",
    },
  },
];
