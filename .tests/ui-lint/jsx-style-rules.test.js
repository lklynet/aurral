import test from "node:test";
import { RuleTester } from "eslint";

import {
  noHardCodedStyleColor,
  noUndefinedStyleToken,
} from "../../frontend/eslint-rules/ui-style-rules.js";

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
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

test("Aurral JSX style color rule allows tokens and dynamic artwork values", () => {
  tester.run("aurral/no-hard-coded-color", noHardCodedStyleColor, {
    valid: [
      {
        code: 'const view = <div style={{ color: "var(--aurral-text)" }} />;',
        options: tokenOptions,
      },
      {
        code: 'const view = <div style={{ backgroundColor: playlist.artworkColor || "#555" }} />;',
        options: tokenOptions,
      },
      {
        code: 'const heroColor = extractedColor || playlist?.artworkColor || "#555"; const view = <div style={{ "--discover-playlist-hero-color": heroColor }} />;',
        options: tokenOptions,
      },
      {
        code: 'const heroColor = extractedColor || playlist?.artworkColor || "#555"; const view = <div style={{ color: getPlaylistTextColor(heroColor) }} />;',
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
  });
});

test("Aurral JSX style token rule reports unknown references and allows runtime geometry", () => {
  tester.run("aurral/no-undefined-token", noUndefinedStyleToken, {
    valid: [
      {
        code: 'const view = <div style={{ color: "var(--aurral-text)" }} />;',
        options: tokenOptions,
      },
      {
        code: 'const view = <div style={{ "--aurral-dot-loader-tile-size": `${size}px`, width: "var(--aurral-dot-loader-tile-size)" }} />;',
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
  });
});
