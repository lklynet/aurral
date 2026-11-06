import { test } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noEmptyConditionalSpread } from "../../frontend/lint-rules/anti-slop-rules.js";

const tester = new RuleTester({ languageOptions: { sourceType: "module" } });

test("conditional spreads with an empty branch become `cond && { ... }`", () => {
  const fixes = [
    ["({ ...(a ? { b } : {}) });", "({ ...(a && { b }) });"],
    ["({ ...(a || c ? { b } : {}) });", "({ ...((a || c) && { b }) });"],
    ["({ ...(a ?? c ? { b } : {}) });", "({ ...((a ?? c) && { b }) });"],
    ["({ ...(a && c ? { b } : {}) });", "({ ...(a && c && { b }) });"],
    ["({ ...(a ? {} : { b }) });", "({ ...(!a && { b }) });"],
    ["({ ...(a.b() ? {} : { b }) });", "({ ...(!a.b() && { b }) });"],
    ["({ ...(a === null ? {} : { b }) });", "({ ...(a !== null && { b }) });"],
    ["({ ...(a != null ? {} : { b }) });", "({ ...(a == null && { b }) });"],
    ["({ ...(a > 1 ? {} : { b }) });", "({ ...(!(a > 1) && { b }) });"],
    ["({ ...(a ? (c ? d : e) : {}) });", "({ ...(a && (c ? d : e)) });"],
  ] as const;
  tester.run(
    "aurral/no-empty-conditional-spread",
    noEmptyConditionalSpread as Parameters<typeof tester.run>[1],
    {
      valid: [
        { code: "({ ...(a ? { b } : { c }) });" },
        { code: "[...(a ? [b] : [])];" },
        { code: "f(...(a ? [b] : []));" },
      ],
      invalid: fixes.map(([code, output]) => ({
        code,
        output,
        errors: [{ messageId: "emptySpread" }],
      })),
    },
  );
});
