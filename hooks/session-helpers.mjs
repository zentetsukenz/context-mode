/**
 * Shared session helpers for context-mode hooks.
 * Used by posttooluse.mjs, precompact.mjs, and sessionstart.mjs.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Read all of stdin as a string (event-based, cross-platform safe).
 */
export function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

/**
 * Derive session ID from hook input.
 * Priority: transcript_path UUID > session_id field > CLAUDE_SESSION_ID env > ppid fallback.
 */
export function getSessionId(input) {
  if (input.transcript_path) {
    const match = input.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (match) return match[1];
  }
  if (input.session_id) return input.session_id;
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  return `pid-${process.ppid}`;
}

/**
 * Return the per-project session DB path.
 * Creates the directory if it doesn't exist.
 * Path: ~/.claude/context-mode/sessions/<SHA256(CLAUDE_PROJECT_DIR)[:16]>.db
 */
export function getSessionDBPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(homedir(), ".claude", "context-mode", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${hash}.db`);
}
