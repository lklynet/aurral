import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../../frontend/", import.meta.url));
const requireFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { ESLint } = requireFrontend("eslint");

test("Aurral JSX rules pass across the current frontend", async () => {
  const eslint = new ESLint({ cwd: frontendRoot });
  const results = await eslint.lintFiles(["src/**/*.js", "src/**/*.jsx"]);
  const findings = results.flatMap((result) =>
    result.messages
      .filter(({ ruleId }) => ruleId?.startsWith("aurral/"))
      .map((message) => ({
        file: path.relative(frontendRoot, result.filePath).replaceAll(path.sep, "/"),
        line: message.line,
        ruleId: message.ruleId,
        message: message.message,
      })),
  );

  assert.deepEqual(findings, []);
});
