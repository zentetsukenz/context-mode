#!/usr/bin/env node
/**
 * UserPromptSubmit hook for context-mode session continuity.
 *
 * Captures every user prompt so the LLM can continue from the exact
 * point where the user left off after compact or session restart.
 *
 * Must be fast (<10ms). Just a single SQLite write.
 */

import { readStdin, getSessionId, getSessionDBPath } from "./session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOOK_DIR = new URL(".", import.meta.url).pathname;
const PKG_SESSION = join(HOOK_DIR, "..", "packages", "session", "dist");
const DEBUG_LOG = join(homedir(), ".claude", "context-mode", "userprompt-debug.log");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  // Debug: log the full input keys and prompt extraction
  const keys = Object.keys(input);
  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] KEYS: ${keys.join(", ")}\n`);
  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] RAW: ${raw.substring(0, 500)}\n`);

  const prompt = input.prompt ?? input.message ?? "";

  if (prompt && prompt.trim().length > 0) {
    const { SessionDB } = await import(join(PKG_SESSION, "db.js"));
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    db.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());
    db.insertEvent(sessionId, {
      type: "user_prompt",
      category: "prompt",
      data: prompt,
      priority: 1,
    }, "UserPromptSubmit");

    db.close();
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] OK: stored prompt (${prompt.length} chars) session=${sessionId}\n`);
  } else {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] SKIP: empty prompt. prompt field="${typeof input.prompt}" message field="${typeof input.message}"\n`);
  }
} catch (err) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ERR: ${err.message}\n`);
  } catch {
    // Silent fallback
  }
}
