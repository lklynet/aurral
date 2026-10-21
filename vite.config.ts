import { readFile } from "node:fs/promises";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import { readAurralTokens } from "./frontend/scripts/ui-token-source.mjs";

const [tokenSource, sharedControlExceptions] = await Promise.all([
  readAurralTokens(),
  readFile(
    new URL("./frontend/lint-rules/shared-control-exceptions.json", import.meta.url),
    "utf8",
  ).then(JSON.parse),
]);
const tokenNames = tokenSource.declarations.map(({ name }) => name);

const testSetup = {
  setupFiles: [".tests/setup-env.js", ".tests/setup-vitest.js"],
  restoreMocks: true,
  testTimeout: 60_000,
};

export default defineConfig({
  fmt: {
    ignorePatterns: [".tests/**/*.json", ".tests/fixtures/**"],
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./frontend/lint-rules/index.js"],
    categories: { correctness: "error" },
    env: { builtin: true, node: true },
    ignorePatterns: ["docs/**", "**/dist/**"],
    options: { typeAware: true },
    rules: {
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        {
          caughtErrors: "none",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "typescript/no-floating-promises": "error",
      "no-case-declarations": "error",
      "no-fallthrough": "error",
      "no-prototype-builtins": "error",
      "no-redeclare": "error",
      "no-regex-spaces": "error",
      "react/display-name": "error",
      "typescript/await-thenable": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-misused-spread": "off",
      "typescript/no-useless-default-assignment": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "unicorn/no-invalid-fetch-options": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-useless-fallback-in-spread": "off",
      "unicorn/no-useless-spread": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
    },
    overrides: [
      {
        files: ["frontend/public/**/*.js", "tests/e2e/**/*.js", ".tests/browser/**"],
        env: { browser: true },
      },
      {
        files: ["frontend/src/**/*.js", "frontend/src/**/*.jsx"],
        env: { browser: true, node: false },
        rules: {
          "typescript/no-floating-promises": "off",
          "no-empty": ["error", { allowEmptyCatch: true }],
          "preserve-caught-error": "error",
          "react/unsupported-syntax": "warn",
          "react/rules-of-hooks": "error",
          "react/exhaustive-deps": "error",
          "react/jsx-key": "error",
          "react/jsx-no-duplicate-props": "error",
          "react/jsx-no-undef": "error",
          "react/no-children-prop": "error",
          "react/no-danger-with-children": "error",
          "react/no-direct-mutation-state": "error",
          "react/no-string-refs": "error",
          "react/no-unescaped-entities": "error",
          "react/no-unknown-property": "error",
          "react/jsx-no-comment-textnodes": "error",
          "react/require-render-return": "error",
          "react/preserve-manual-memoization": "off",
          "react/purity": "off",
          "react/refs": "off",
          "react/set-state-in-effect": "off",
          "aurral/no-hard-coded-style-color": ["error", { tokenNames }],
          "aurral/no-undefined-style-token": ["error", { tokenNames }],
          "aurral/shared-control-patterns": ["error", { exceptions: sharedControlExceptions }],
          "aurral/no-native-tooltip": "error",
        },
      },
      {
        files: ["frontend/src/**/*.jsx"],
        rules: { "aurral/single-main": "error" },
      },
      {
        files: [
          "frontend/src/components/Layout.jsx",
          "frontend/src/pages/Login.jsx",
          "frontend/src/pages/SsoComplete.jsx",
        ],
        rules: { "aurral/single-main": "off" },
      },
      {
        files: [
          "backend/services/logger.js",
          "backend/services/importLists/lastfmStations.js",
          "backend/services/plexLoginAuth.js",
        ],
        rules: { "eslint/no-control-regex": "off" },
      },
    ],
  },
  test: {
    projects: [
      {
        test: {
          ...testSetup,
          name: "unit",
          include: [".tests/**/*.test.js"],
          exclude: [".tests/**/*.int.test.js"],
        },
      },
      {
        test: {
          ...testSetup,
          name: "integration",
          include: [".tests/**/*.int.test.js"],
        },
      },
      {
        test: {
          name: "browser",
          include: [".tests/browser/**/*.test.jsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
