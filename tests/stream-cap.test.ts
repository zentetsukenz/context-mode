import { describe, test, expect } from "vitest";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes } from "../src/runtime.js";

const runtimes = detectRuntimes();

describe("Stdout Cap", () => {
  test("stdout: process killed when output exceeds hard cap", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 4000; i++) console.log("x".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Expected cap message in stderr, got: " + r.stderr.slice(-200));
    assert.ok(r.stderr.includes("process killed"), "Expected 'process killed' in stderr");
  });
});

describe("Stderr Cap", () => {
  test("stderr: process killed when stderr exceeds hard cap", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 4000; i++) console.error("e".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Expected cap message in stderr for stderr-heavy output");
  });
});

describe("Combined Cap", () => {
  test("combined: cap triggers on total stdout+stderr bytes", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 2048, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 200; i++) process.stdout.write("o".repeat(10) + "\\n");\nfor (let i = 0; i < 200; i++) process.stderr.write("e".repeat(10) + "\\n");',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Combined output should have triggered the cap");
  });
});

describe("Normal Operation", () => {
  test("normal: small output below cap works correctly", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024 * 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("hello from capped executor");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from capped executor"));
    assert.ok(!r.stderr.includes("output capped"), "Should NOT contain cap message for small output");
  });

  test("normal: moderate output below cap preserves all content", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024 * 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 50; i++) console.log("line-" + i);',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("line-0"), "Should contain first line");
    assert.ok(r.stdout.includes("line-49"), "Should contain last line");
    assert.ok(!r.stderr.includes("output capped"));
  });
});

describe("Memory Bounding", () => {
  test("memory: collected stdout bytes stay bounded near cap", async () => {
    const capBytes = 4096;
    const executor = new PolyglotExecutor({ hardCapBytes: capBytes, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 20000; i++) console.log("x".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Cap should have triggered");
    const stdoutBytes = Buffer.byteLength(r.stdout);
    const tolerance = 256 * 1024;
    assert.ok(stdoutBytes < capBytes + tolerance, "Collected " + stdoutBytes + " bytes stdout; expected bounded near " + capBytes);
  });
});

describe("Cap Message Format", () => {
  test("format: cap message reports correct MB value for 2MB cap", async () => {
    const twoMB = 2 * 1024 * 1024;
    const executor = new PolyglotExecutor({ hardCapBytes: twoMB, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 100000; i++) process.stdout.write("x".repeat(49) + "\\n");',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("2MB"), "Expected '2MB' in cap message: " + r.stderr.slice(-200));
    assert.ok(r.stderr.includes("process killed"));
  });

  test("format: cap message uses em dash and bracket format", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 4000; i++) console.log("x".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("\u2014"), "Cap message should use em dash");
    assert.ok(r.stderr.includes("[output capped at"), "Cap message should start with '[output capped at'");
  });
});

describe("Timeout Independence", () => {
  test("timeout: still fires when output is slow and under cap", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 100 * 1024 * 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: "while(true) {}",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
    assert.ok(!r.stderr.includes("output capped"), "Should be timeout, not cap");
  });

  test("timeout: cap fires before timeout for fast-producing process", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 100000; i++) console.log("x".repeat(50));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Cap should fire before timeout");
    assert.equal(r.timedOut, false, "timedOut should be false when cap killed the process");
  });
});

describe("Default Cap", () => {
  test("default: executor works with default hardCapBytes (no option)", async () => {
    const executor = new PolyglotExecutor({ runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("default cap works");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("default cap works"));
  });
});

describe("Smart Truncation Interaction", () => {
  test("truncation: hardCap and maxOutputBytes work together", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 50 * 1024, maxOutputBytes: 1024, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 4000; i++) console.log("x".repeat(25));',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Hard cap should trigger");
    const stdoutBytes = Buffer.byteLength(r.stdout);
    assert.ok(stdoutBytes < 50 * 1024, "Final stdout should be truncated by smartTruncate, got " + stdoutBytes + " bytes");
  });
});

describe("Cross-Language Cap", () => {
  test("shell: cap works with shell scripts", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 2048, runtimes });
    const r = await executor.execute({
      language: "shell",
      code: 'yes "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" | head -c 100000',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Cap should trigger for shell output");
  });

  test.runIf(runtimes.python)("python: cap works with python scripts", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 2048, runtimes });
    const r = await executor.execute({
      language: "python",
      code: 'import sys\nfor i in range(10000):\n    sys.stdout.write("x" * 50 + "\\n")',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Cap should trigger for python output");
  });
});

describe("Interleaved Output", () => {
  test("interleaved: rapid alternating stdout/stderr triggers cap", async () => {
    const executor = new PolyglotExecutor({ hardCapBytes: 4096, runtimes });
    const r = await executor.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 5000; i++) { if (i % 2 === 0) process.stdout.write("out" + i + "\\n"); else process.stderr.write("err" + i + "\\n"); }',
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped"), "Interleaved output should trigger cap");
  });
});

describe("executeFile Cap", () => {
  test("executeFile: cap applies to file execution too", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cap-test-"));
    const testFile = join(tmpDir, "data.txt");
    writeFileSync(testFile, "test content", "utf-8");

    try {
      const executor = new PolyglotExecutor({ hardCapBytes: 1024, runtimes });
      const r = await executor.executeFile({
        path: testFile,
        language: "javascript",
        code: 'for (let i = 0; i < 4000; i++) console.log("x".repeat(25));',
        timeout: 10_000,
      });
      assert.ok(r.stderr.includes("output capped"), "executeFile should also respect the hard cap");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
