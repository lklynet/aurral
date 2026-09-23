import test from "node:test";
import { RuleTester } from "eslint";

import { noNativeTooltipRules } from "../../frontend/eslint-rules/native-tooltip-rules.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

test("Aurral tooltips use the shared tooltip components", () => {
  tester.run("aurral/no-native-tooltip", noNativeTooltipRules, {
    valid: [
      { code: '<Tooltip content={fullName}><span>{fullName}</span></Tooltip>;' },
      { code: '<TooltipButton label="Close"><CloseIcon /></TooltipButton>;' },
      { code: '<TooltipButton title="Close"><CloseIcon /></TooltipButton>;' },
      { code: '<iframe title="Embedded player" src={url} />;' },
      { code: '<DiscoverRail title="Recently added" />;' },
    ],
    invalid: [
      {
        code: '<button title="Close"><CloseIcon /></button>;',
        errors: [{ messageId: "nativeTitle" }],
      },
      {
        code: '<span title={fullName}>{fullName}</span>;',
        errors: [{ messageId: "nativeTitle" }],
      },
      {
        code: '<Tooltip><span>Track</span></Tooltip>;',
        errors: [{ messageId: "missingContent" }],
      },
      {
        code: '<TooltipButton><CloseIcon /></TooltipButton>;',
        errors: [{ messageId: "missingLabel" }],
      },
    ],
  });
});
