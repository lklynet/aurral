import test from "node:test";
import { RuleTester } from "eslint";

import { sharedControlRules } from "../../frontend/eslint-rules/shared-control-rules.js";

const rowException = {
  id: "media-row-icon-action",
  file: "src/MediaRow.jsx",
  className: "btn-icon-square",
  reason: "This existing media-row action uses the shared button style with a native tooltip.",
};
const arrException = {
  id: "settings-arr-confirmation-action",
  file: "src/pages/Settings/components/SettingsUsersTab.jsx",
  className: "arr-btn",
  reason: "The settings confirmation modal keeps its established Arr button surface.",
};
const controlOptions = [{ exceptions: [rowException, arrException] }];
const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

test("shared control rules accept Aurral button patterns and named exceptions", () => {
  tester.run("aurral/shared-controls", sharedControlRules, {
    valid: [
      {
        code: '<button type="button" className="btn btn-primary">Save</button>;',
        options: controlOptions,
      },
      {
        code: '<button type="button" className="settings-arr__toggle">Save</button>;',
        options: controlOptions,
      },
      {
        code: '<TooltipButton label="Close" className="artist-modal__close"><CloseIcon /></TooltipButton>;',
        options: controlOptions,
      },
      {
        code: 'function Button({ className }) { return <TooltipButton label="More" className={className}><MoreIcon /></TooltipButton>; }',
        options: controlOptions,
      },
      {
        code: '<TooltipButton label="More" className="btn btn-ghost btn-icon"><MoreIcon /></TooltipButton>;',
        options: controlOptions,
      },
      {
        code: '<button type="button" className="btn btn-primary"><>Continue <ArrowIcon /></></button>;',
        options: controlOptions,
      },
      {
        code: 'const classes = ["btn", "btn-add-action", className].filter(Boolean).join(" "); <TooltipButton label="Add item" className={classes}><PlusIcon /></TooltipButton>;',
        options: controlOptions,
      },
      {
        code: '<AddActionButton label="Add to Lidarr" />;',
        options: controlOptions,
      },
      {
        code: '<button role="menuitem" onClick={select}>Delete</button>;',
        options: controlOptions,
      },
      {
        filename: "src/MediaRow.jsx",
        code: '<button className="media-row-button" onClick={open}>Album</button>;',
        options: controlOptions,
      },
      {
        filename: "src/MediaRow.jsx",
        code: '<button className="btn btn-icon-square" aria-label="Play album"><PlayIcon /></button>;',
        options: controlOptions,
      },
      {
        filename: "src/pages/Settings/components/SettingsUsersTab.jsx",
        code: '<button className="arr-btn btn-danger">Delete</button>;',
        options: controlOptions,
      },
    ],
    invalid: [
      {
        code: '<button type="button" onClick={save}>Save</button>;',
        options: controlOptions,
        errors: [{ messageId: "standardAction" }],
      },
      {
        code: '<button type="button" className="btn-primary" onClick={save}>Save</button>;',
        options: controlOptions,
        errors: [{ messageId: "standardAction" }],
      },
      {
        code: '<button className="btn btn-icon" aria-label="Close"><CloseIcon /></button>;',
        options: controlOptions,
        errors: [{ messageId: "iconAction" }],
      },
      {
        code: '<TooltipButton label="Close" className="btn-icon"><CloseIcon /></TooltipButton>;',
        options: controlOptions,
        errors: [{ messageId: "sharedButtonBase" }],
      },
      {
        code: '<button className="btn btn-icon" aria-label="Add to Lidarr"><PlusIcon /></button>;',
        options: controlOptions,
        errors: [{ messageId: "addAction" }],
      },
      {
        filename: "src/OtherRow.jsx",
        code: '<button className="btn btn-icon-square" aria-label="Play album"><PlayIcon /></button>;',
        options: controlOptions,
        errors: [{ messageId: "iconAction" }],
      },
      {
        filename: "src/OtherSettings.jsx",
        code: '<button className="arr-btn btn-danger">Delete</button>;',
        options: controlOptions,
        errors: [{ messageId: "standardAction" }],
      },
    ],
  });
});
