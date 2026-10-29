import { test } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";

import { sharedControlRules } from "../../frontend/lint-rules/shared-control-rules.js";

const tester = new RuleTester({
  languageOptions: {
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

test("shared control rules accept Aurral button patterns", () => {
  tester.run("aurral/shared-controls", sharedControlRules as Parameters<typeof tester.run>[1], {
    valid: [
      {
        code: '<button type="button" className="btn btn-primary">Save</button>;',
      },
      {
        code: '<button type="button" className="settings-arr__toggle">Save</button>;',
      },
      {
        code: '<TooltipButton label="Close" className="artist-modal__close"><CloseIcon /></TooltipButton>;',
      },
      {
        code: 'function Button({ className }) { return <TooltipButton label="More" className={className}><MoreIcon /></TooltipButton>; }',
      },
      {
        code: '<TooltipButton label="More" className="btn btn-ghost btn-icon"><MoreIcon /></TooltipButton>;',
      },
      {
        code: '<button type="button" className="btn btn-primary"><>Continue <ArrowIcon /></></button>;',
      },
      {
        code: '<button type="button" className="btn btn-primary">{label || null}</button>;',
      },
      {
        code: '<button type="button" className="btn btn-primary">{label ?? null}</button>;',
      },
      {
        code: '<button type="button" className="btn btn-primary">{ready && label}</button>;',
      },
      {
        code: '<button type="button" className={`btn-primary ${"btn"}`}>Save</button>;',
      },
      {
        code: 'const classes = ["btn", "btn-add-action", className].filter(Boolean).join(" "); <TooltipButton label="Add item" className={classes}><PlusIcon /></TooltipButton>;',
      },
      {
        code: 'const classes = cn("btn", active && "btn-primary"); <button className={classes}>Save</button>;',
      },
      {
        code: '<button role="menuitem" onClick={select}>Delete</button>;',
      },
    ],
    invalid: [
      {
        code: '<button type="button" onClick={save}>Save</button>;',
        errors: [{ messageId: "standardAction" }],
      },
      {
        code: '<button type="button" className="btn-primary" onClick={save}>Save</button>;',
        errors: [{ messageId: "standardAction" }],
      },
      {
        code: '<button className="btn btn-icon" aria-label="Close"><CloseIcon /></button>;',
        errors: [{ messageId: "iconAction" }],
      },
      {
        code: '<TooltipButton label="Close" className="btn-icon"><CloseIcon /></TooltipButton>;',
        errors: [{ messageId: "sharedButtonBase" }],
      },
      {
        code: '<button type="button" className={cn("btn-primary")}>Save</button>;',
        errors: [{ messageId: "standardAction" }],
      },
      {
        code: 'const classes = ["btn-primary", enabled && "btn"].filter(Boolean).join(" "); <button className={classes}>Save</button>;',
        errors: [{ messageId: "standardAction" }],
      },
      {
        code: '<button className={enabled ? "btn btn-primary" : "btn-ghost"}>Save</button>;',
        errors: [{ messageId: "standardAction" }],
      },
      {
        code: '<button>{label || <Search aria-hidden="true" />}</button>;',
        errors: [{ messageId: "iconAction" }],
      },
    ],
  });
});

test("shared control rules treat dynamic text expressions as visible button content", () => {
  tester.run(
    "aurral/shared-controls-visible-expressions",
    sharedControlRules as Parameters<typeof tester.run>[1],
    {
      valid: [
        {
          code: 'const view = <button className="btn btn-secondary">{artist.name}</button>;',
        },
        {
          code: 'const view = <button className="btn btn-secondary">{artist?.name}</button>;',
        },
        {
          code: 'function Button({ props }) { return <button className="btn btn-secondary">{props.children}</button>; }',
        },
        {
          code: 'const view = <button className="btn btn-secondary">{label`Open ${artist.name}`}</button>;',
        },
      ],
      invalid: [],
    },
  );
});
