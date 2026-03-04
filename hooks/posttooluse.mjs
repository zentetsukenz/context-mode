#!/usr/bin/env node
/**
 * PostToolUse hook for context-mode session continuity.
 *
 * Captures session events from tool calls (13 categories) and stores
 * them in the per-project SessionDB for later resume snapshot building.
 *
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 */

import { readStdin, getSessionId, getSessionDBPath } from "./session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Resolve absolute path for imports — relative dynamic imports can fail
// when Claude Code invokes hooks from a different working directory.
const HOOK_DIR = new URL(".", import.meta.url).pathname;
const PKG_SESSION = join(HOOK_DIR, "..", "packages", "session", "dist");

const DEBUG_LOG = join(homedir(), ".claude", "context-mode", "posttooluse-debug.log");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  // Log every invocation for debugging
  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] CALL: ${input.tool_name}\n`);

  const { extractEvents } = await import(join(PKG_SESSION, "extract.js"));
  const { SessionDB } = await import(join(PKG_SESSION, "db.js"));

  const dbPath = getSessionDBPath();
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input);

  // Ensure session meta exists
  db.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

  // Extract and store events
  const events = extractEvents({
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
    tool_output: input.tool_output,
  });

  for (const event of events) {
    db.insertEvent(sessionId, event, "PostToolUse");
  }

  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] OK: ${input.tool_name} → ${events.length} events\n`);
  db.close();
} catch (err) {
  // Log errors for debugging — PostToolUse must never block the session
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ERR: ${err.message}\n`);
  } catch {
    // Even logging can fail — truly silent fallback
  }
}

// PostToolUse hooks don't need hookSpecificOutput
