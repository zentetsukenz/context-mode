/**
 * CLI Hook Path Tests
 *
 * Verifies that hook command paths written to settings.json use forward slashes.
 * On Windows, Node.js resolve() returns backslashes which are stripped by
 * Bash (MSYS2) — the shell Claude Code uses on Windows.
 *
 * See: https://github.com/mksglu/claude-context-mode/issues/55
 */

import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { toUnixPath } from "../src/cli.js";

describe("CLI Hook Path Tests", () => {
  test("toUnixPath: converts backslashes to forward slashes", () => {
    const input = "C:\\Users\\xxx\\AppData\\Local\\npm-cache\\_npx\\hooks\\pretooluse.mjs";
    const result = toUnixPath(input);
    assert.ok(
      !result.includes("\\"),
      `Expected no backslashes, got: ${result}`,
    );
    assert.equal(
      result,
      "C:/Users/xxx/AppData/Local/npm-cache/_npx/hooks/pretooluse.mjs",
    );
  });

  test("toUnixPath: leaves forward-slash paths unchanged", () => {
    const input = "/home/user/.claude/plugins/context-mode/hooks/pretooluse.mjs";
    const result = toUnixPath(input);
    assert.equal(result, input);
  });

  test("toUnixPath: handles mixed slashes", () => {
    const input = "C:/Users\\xxx/AppData\\Local\\hooks/pretooluse.mjs";
    const result = toUnixPath(input);
    assert.ok(!result.includes("\\"), `Expected no backslashes, got: ${result}`);
  });

  test("toUnixPath: hook command string has no backslashes", () => {
    // Simulate what upgrade() does: "node " + resolve(...)
    // On Windows, resolve() returns backslashes — toUnixPath must normalize them
    const windowsPath = "C:\\Users\\xxx\\.claude\\plugins\\cache\\context-mode\\hooks\\pretooluse.mjs";
    const command = "node " + toUnixPath(windowsPath);
    assert.ok(
      !command.includes("\\"),
      `Hook command must not contain backslashes: ${command}`,
    );
  });

  test("toUnixPath: sessionstart path has no backslashes", () => {
    const windowsPath = "C:\\Users\\xxx\\.claude\\plugins\\cache\\context-mode\\hooks\\sessionstart.mjs";
    const command = "node " + toUnixPath(windowsPath);
    assert.ok(
      !command.includes("\\"),
      `SessionStart command must not contain backslashes: ${command}`,
    );
  });
});
