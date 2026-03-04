#!/usr/bin/env node
/**
 * Post-build import rewriter.
 *
 * Rewrites workspace package imports (@context-mode/shared/*)
 * to relative paths in the compiled session dist output.
 * This ensures the published npm package works without workspace symlinks.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_DIST = join(import.meta.dirname, "..", "packages", "session", "dist");

const REWRITES = [
  // @context-mode/shared/db-base → ../../shared/dist/db-base.js
  [/@context-mode\/shared\/db-base/g, "../../shared/dist/db-base.js"],
  [/@context-mode\/shared\/truncate/g, "../../shared/dist/truncate.js"],
  [/@context-mode\/shared\/types/g, "../../shared/dist/types.js"],
];

let rewritten = 0;

for (const file of readdirSync(SESSION_DIST)) {
  if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;

  const filePath = join(SESSION_DIST, file);
  let content = readFileSync(filePath, "utf-8");
  let changed = false;

  for (const [pattern, replacement] of REWRITES) {
    if (pattern.test(content)) {
      content = content.replace(pattern, replacement);
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(filePath, content);
    rewritten++;
    console.log(`  Rewritten: ${file}`);
  }
}

console.log(`fix-imports: ${rewritten} files rewritten`);
