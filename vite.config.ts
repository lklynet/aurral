import { defineConfig } from "vite-plus";
import { readAurralTokens } from "./frontend/scripts/ui-token-source.mts";

const tokenSource = await readAurralTokens();
const tokenNames = tokenSource.declarations.map(({ name }) => name);

const testSetup = {
  globalSetup: ".tests/global-setup.ts",
  setupFiles: [".tests/setup-env.ts", ".tests/setup-vitest.ts"],
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
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript", "import"],
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
      "typescript/no-explicit-any": "error",
      "typescript/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true },
      ],
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
      "typescript/no-this-alias": "off",
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
        files: ["frontend/public/**/*.js", "web/share-page.js"],
        env: { browser: true },
      },
      {
        files: ["frontend/src/**/*.ts", "frontend/src/**/*.tsx"],
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
          "aurral/shared-control-patterns": "error",
          "aurral/no-native-tooltip": "error",
        },
      },
      {
        files: ["frontend/src/**/*.tsx"],
        rules: { "aurral/single-main": "error" },
      },
      {
        files: [
          "frontend/src/components/Layout.tsx",
          "frontend/src/pages/Login.tsx",
          "frontend/src/pages/SsoComplete.tsx",
        ],
        rules: { "aurral/single-main": "off" },
      },
      {
        files: ["backend/**", "lib/**", "scripts/**", ".tests/**"],
        rules: { "import/extensions": ["error", "always", { ignorePackages: true }] },
      },
      {
        files: [
          "backend/services/logger.ts",
          "backend/services/importLists/lastfmStations.ts",
          "backend/services/plexLoginAuth.ts",
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
          include: [".tests/**/*.test.ts"],
          exclude: [".tests/**/*.int.test.ts"],
        },
      },
      {
        test: {
          ...testSetup,
          name: "integration",
          include: [".tests/**/*.int.test.ts"],
        },
      },
    ],
  },
});
