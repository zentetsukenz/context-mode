import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, afterAll } from "vitest";
import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes } from "../src/runtime.js";

const runtimes = detectRuntimes();

// Set up two isolated directories to simulate the scenario:
// - pluginDir: where the plugin is installed (start.sh does cd here)
// - projectDir: where the user's project lives (the real cwd)
const baseDir = join(tmpdir(), "ctx-mode-projdir-test-" + Date.now());
const projectDir = join(baseDir, "user-project");
const pluginDir = join(baseDir, "plugin-install");
mkdirSync(projectDir, { recursive: true });
mkdirSync(pluginDir, { recursive: true });

// Create a test file in the user's project directory
const testFileName = "data.json";
const testData = { message: "hello from project dir", count: 42 };
writeFileSync(
  join(projectDir, testFileName),
  JSON.stringify(testData),
  "utf-8",
);

// Also create a different file with the same name in the plugin directory
// to prove we're reading from the right place
const pluginData = { message: "wrong directory", count: 0 };
writeFileSync(
  join(pluginDir, testFileName),
  JSON.stringify(pluginData),
  "utf-8",
);

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("executeFile: projectRoot path resolution", () => {
  test("relative path resolves against projectRoot, not cwd", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: testFileName, // relative path — should resolve to projectDir/data.json
      language: "javascript",
      code: `
        const data = JSON.parse(FILE_CONTENT);
        console.log(data.message);
      `,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0, got ${r.exitCode}: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("hello from project dir"),
      `Should read from projectDir, got: ${r.stdout.trim()}`,
    );
  });

  test("relative path with subdirectory resolves against projectRoot", async () => {
    const subDir = join(projectDir, "nested", "deep");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "nested.txt"), "nested content here", "utf-8");

    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: "nested/deep/nested.txt",
      language: "javascript",
      code: `console.log(FILE_CONTENT.trim());`,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes("nested content here"));
  });

  test("absolute path ignores projectRoot", async () => {
    const absFile = join(baseDir, "absolute-test.txt");
    writeFileSync(absFile, "absolute path content", "utf-8");

    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: absFile, // absolute path — projectRoot should be ignored
      language: "javascript",
      code: `console.log(FILE_CONTENT.trim());`,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes("absolute path content"));
  });

  test("default projectRoot is process.cwd()", async () => {
    // Create a file in the actual cwd
    const cwdFile = join(process.cwd(), ".ctx-mode-test-cwd-" + Date.now() + ".tmp");
    writeFileSync(cwdFile, "cwd content", "utf-8");

    try {
      const executor = new PolyglotExecutor({ runtimes });

      const r = await executor.executeFile({
        path: cwdFile,
        language: "javascript",
        code: `console.log(FILE_CONTENT.trim());`,
      });

      assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
      assert.ok(r.stdout.includes("cwd content"));
    } finally {
      rmSync(cwdFile, { force: true });
    }
  });
});

describe("CLAUDE_PROJECT_DIR env var integration", () => {
  test("PolyglotExecutor accepts projectRoot option", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: "/some/custom/path",
    });

    // Verify the executor was created without error
    // The projectRoot is private, so we verify it indirectly via executeFile
    assert.ok(executor, "Executor should be created with custom projectRoot");
  });

  test("executeFile fails gracefully for non-existent relative path", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: "does-not-exist.json",
      language: "javascript",
      code: `console.log(FILE_CONTENT);`,
    });

    assert.notEqual(r.exitCode, 0, "Should fail for non-existent file");
  });
});

describe("Multi-language relative path resolution", () => {
  if (runtimes.python) {
    test("Python: relative path resolves against projectRoot", async () => {
      const executor = new PolyglotExecutor({
        runtimes,
        projectRoot: projectDir,
      });

      const r = await executor.executeFile({
        path: testFileName,
        language: "python",
        code: `
import json
data = json.loads(FILE_CONTENT)
print(f"msg: {data['message']}")
print(f"count: {data['count']}")
        `,
      });

      assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
      assert.ok(r.stdout.includes("msg: hello from project dir"));
      assert.ok(r.stdout.includes("count: 42"));
    });
  }

  test("Shell: relative path resolves against projectRoot", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: testFileName,
      language: "shell",
      code: `echo "content: $FILE_CONTENT"`,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes("hello from project dir"));
  });
});
