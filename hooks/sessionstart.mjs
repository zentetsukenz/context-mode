#!/usr/bin/env node
/**
 * SessionStart hook for context-mode
 *
 * Provides the agent with XML-structured "Rules of Engagement"
 * at the beginning of each session. Injects session knowledge on
 * both startup and compact to maintain continuity.
 *
 * Session Lifecycle Rules:
 * - "startup"  → Fresh session. Inject previous session knowledge. Cleanup old data.
 * - "compact"  → Auto-compact triggered. Inject resume snapshot + stats.
 * - "resume"   → User used --continue. Full history, no resume needed.
 * - "clear"    → User cleared context. No resume.
 */

import { ROUTING_BLOCK } from "./routing-block.mjs";
import { readStdin, getSessionId, getSessionDBPath } from "./session-helpers.mjs";
import { join } from "node:path";

// Resolve absolute path for imports
const HOOK_DIR = new URL(".", import.meta.url).pathname;
const PKG_SESSION = join(HOOK_DIR, "..", "packages", "session", "dist");

const raw = await readStdin();
let additionalContext = ROUTING_BLOCK;

try {
  const input = JSON.parse(raw);
  const source = input.source ?? "startup";

  // ── Helper: build structured session knowledge injection for the LLM ──
  // The LLM doesn't care about counts — it cares about WHAT data was preserved.
  // ZERO truncation: full event data flows through. The LLM indexes it into
  // context-mode for persistent searchable access across compacts.
  function buildSessionKnowledge(source, events, snapshot, stats) {
    const isCompact = source === "compact";

    // ── Group events by category — no truncation, no limits ──
    const grouped = {};
    let lastPrompt = "";

    for (const ev of events) {
      if (ev.category === "prompt") {
        // Always keep the most recent user prompt
        lastPrompt = ev.data;
        continue;
      }
      if (!grouped[ev.category]) grouped[ev.category] = [];
      grouped[ev.category].push(ev);
    }

    // ── Deduplicate file basenames for quick reference ──
    const fileNames = new Set();
    for (const ev of (grouped.file || [])) {
      const path = ev.data.includes(" in ") ? ev.data.split(" in ").pop() : ev.data;
      const base = path?.split("/").pop()?.trim();
      if (base && !base.includes("*")) fileNames.add(base);
    }

    let block = `\n<session_knowledge source="${isCompact ? "compact" : "previous_session"}" events="${events.length}">`;

    // ── Behavioral directives ──
    block += `\n  <behavioral_directives>`;
    // ── Build marketing summary lines from actual data ──
    const summaryLines = [];
    if (fileNames.size > 0) summaryLines.push(`${fileNames.size} files tracked (${[...fileNames].slice(0, 5).join(", ")}${fileNames.size > 5 ? "..." : ""})`);
    if (grouped.rule?.length > 0) summaryLines.push(`CLAUDE.md rules preserved`);
    if (grouped.decision?.length > 0) summaryLines.push(`${grouped.decision.length} user decision(s) remembered`);
    if (grouped.task?.length > 0) summaryLines.push(`${grouped.task.length} task(s) in progress`);
    if (grouped.git?.length > 0) summaryLines.push(`git state tracked`);
    if (grouped.error?.length > 0) summaryLines.push(`${grouped.error.length} error(s) logged`);
    if (lastPrompt) summaryLines.push(`last request preserved`);

    if (isCompact) {
      block += `\n    Your context was compacted. The data below is your prior session state, preserved by context-mode.`;
      block += `\n    IMPORTANT: This data IS your memory. Treat it as ground truth for this session.`;
      block += `\n    MANDATORY FIRST ACTION: Index the <session_events> block below into context-mode for persistent searchable access:`;
      block += `\n      mcp__plugin_context-mode_context-mode__index(source: "session-resume", content: <session_events content>)`;
      block += `\n    Then continue the user's last request.`;
    } else {
      block += `\n    Knowledge from a previous session on this project, preserved by context-mode.`;
      block += `\n    Use as context. Verify file state before editing.`;
      block += `\n    RECOMMENDED: Index the <session_events> block into context-mode for searchable access:`;
      block += `\n      mcp__plugin_context-mode_context-mode__index(source: "previous-session", content: <session_events content>)`;
    }

    // ── User-facing summary — LLM MUST display this table ──
    const tableRows = [];
    if (fileNames.size > 0) {
      const preview = [...fileNames].slice(0, 5).join(", ");
      tableRows.push(`| Files tracked | ${fileNames.size} | ${preview}${fileNames.size > 5 ? ", ..." : ""} |`);
    }
    if (grouped.rule?.length > 0) {
      const rPaths = grouped.rule.filter(e => e.type !== "rule_content").map(e => e.data.split("/").pop());
      tableRows.push(`| Project rules | ${grouped.rule.length} | ${rPaths.join(", ") || "CLAUDE.md"} |`);
    }
    if (grouped.decision?.length > 0) {
      const dPreview = grouped.decision.slice(0, 2).map(e => e.data.substring(0, 50)).join("; ");
      tableRows.push(`| Your decisions | ${grouped.decision.length} | ${dPreview} |`);
    }
    if (grouped.task?.length > 0) {
      tableRows.push(`| Tasks in progress | ${grouped.task.length} | Continuing where you left off |`);
    }
    if (grouped.git?.length > 0) {
      const ops = [...new Set(grouped.git.map(e => e.data))].slice(0, 3).join(", ");
      tableRows.push(`| Git state | ${grouped.git.length} | ${ops} |`);
    }
    if (grouped.error?.length > 0) {
      tableRows.push(`| Errors caught | ${grouped.error.length} | Being monitored |`);
    }
    if (grouped.env?.length > 0) {
      tableRows.push(`| Environment | ${grouped.env.length} | Setup preserved |`);
    }
    if (lastPrompt) {
      const promptPreview = lastPrompt.length > 60 ? lastPrompt.substring(0, 57) + "..." : lastPrompt;
      tableRows.push(`| Last request | 1 | "${promptPreview}" |`);
    }

    if (tableRows.length > 0) {
      block += `\n    DISPLAY TO USER: Before doing anything else, show this status table to the user exactly as formatted:`;
      block += `\n    ---`;
      block += `\n    **context-mode** — session ${isCompact ? "restored" : "loaded"}`;
      block += `\n    `;
      block += `\n    | Preserved | Count | Details |`;
      block += `\n    |-----------|------:|---------|`;
      for (const row of tableRows) {
        block += `\n    ${row}`;
      }
      if (isCompact) {
        block += `\n    `;
        block += `\n    *Context was compacted — all session knowledge restored. Continuing seamlessly.*`;
      } else {
        block += `\n    `;
        block += `\n    *Previous session knowledge loaded. Use \`--continue\` to keep full history — without it, old session data is cleared.*`;
      }
      block += `\n    ---`;
    }
    block += `\n  </behavioral_directives>`;

    // ── Last user prompt — the LLM must continue from here ──
    if (lastPrompt) {
      block += `\n  <last_user_prompt>`;
      block += `\n    ${lastPrompt}`;
      block += `\n  </last_user_prompt>`;
      if (isCompact) {
        block += `\n  <continue_from>Continue working on the request above. Do NOT ask the user to repeat themselves.</continue_from>`;
      }
    }

    // ── Full session events grouped by category — ZERO truncation ──
    block += `\n  <session_events>`;

    // Files (P1)
    if (fileNames.size > 0) {
      block += `\n    <active_files>`;
      for (const name of fileNames) {
        block += `\n      <file>${name}</file>`;
      }
      block += `\n    </active_files>`;
    }

    // Rules + content (P1)
    if (grouped.rule?.length > 0) {
      block += `\n    <rules>`;
      for (const ev of grouped.rule) {
        if (ev.type === "rule_content") {
          block += `\n      <rule_content>${ev.data}</rule_content>`;
        } else {
          block += `\n      <rule_path>${ev.data}</rule_path>`;
        }
      }
      block += `\n    </rules>`;
    }

    // Tasks (P1)
    if (grouped.task?.length > 0) {
      block += `\n    <tasks>`;
      for (const ev of grouped.task) {
        block += `\n      <task>${ev.data}</task>`;
      }
      block += `\n    </tasks>`;
    }

    // Decisions (P2)
    if (grouped.decision?.length > 0) {
      block += `\n    <decisions>`;
      for (const ev of grouped.decision) {
        block += `\n      <decision>${ev.data}</decision>`;
      }
      block += `\n    </decisions>`;
    }

    // Git (P2)
    if (grouped.git?.length > 0) {
      block += `\n    <git_operations>`;
      for (const ev of grouped.git) {
        block += `\n      <op>${ev.data}</op>`;
      }
      block += `\n    </git_operations>`;
    }

    // Environment (P2)
    if (grouped.env?.length > 0) {
      block += `\n    <environment>`;
      for (const ev of grouped.env) {
        block += `\n      <env>${ev.data}</env>`;
      }
      block += `\n    </environment>`;
    }

    // Working directory (P2)
    if (grouped.cwd?.length > 0) {
      const lastCwd = grouped.cwd[grouped.cwd.length - 1];
      block += `\n    <cwd>${lastCwd.data}</cwd>`;
    }

    // Errors (P2)
    if (grouped.error?.length > 0) {
      block += `\n    <errors>`;
      for (const ev of grouped.error) {
        block += `\n      <error>${ev.data}</error>`;
      }
      block += `\n    </errors>`;
    }

    // MCP tools (P3)
    if (grouped.mcp?.length > 0) {
      const toolCounts = {};
      for (const ev of grouped.mcp) {
        const tool = ev.data.split(":")[0].trim();
        toolCounts[tool] = (toolCounts[tool] || 0) + 1;
      }
      block += `\n    <mcp_tools>`;
      for (const [tool, count] of Object.entries(toolCounts)) {
        block += `\n      <tool name="${tool}" calls="${count}" />`;
      }
      block += `\n    </mcp_tools>`;
    }

    // Subagents (P3)
    if (grouped.subagent?.length > 0) {
      block += `\n    <subagents>`;
      for (const ev of grouped.subagent) {
        block += `\n      <task>${ev.data}</task>`;
      }
      block += `\n    </subagents>`;
    }

    // Skills (P3)
    if (grouped.skill?.length > 0) {
      const uniqueSkills = new Set(grouped.skill.map(e => e.data));
      block += `\n    <skills>${[...uniqueSkills].join(", ")}</skills>`;
    }

    // Intent (P3)
    if (grouped.intent?.length > 0) {
      const lastIntent = grouped.intent[grouped.intent.length - 1];
      block += `\n    <intent>${lastIntent.data}</intent>`;
    }

    // Role (P3)
    if (grouped.role?.length > 0) {
      const lastRole = grouped.role[grouped.role.length - 1];
      block += `\n    <role>${lastRole.data}</role>`;
    }

    // User data references (P4)
    if (grouped.data?.length > 0) {
      block += `\n    <data_refs>`;
      for (const ev of grouped.data) {
        block += `\n      <ref>${ev.data}</ref>`;
      }
      block += `\n    </data_refs>`;
    }

    block += `\n  </session_events>`;

    // ── Session metadata ──
    if (stats?.compact_count > 0) {
      block += `\n  <session_meta compact_count="${stats.compact_count}" />`;
    }

    block += `\n</session_knowledge>`;
    return block;
  }

  if (source === "compact") {
    // Session was compacted — inject structured resume context
    const { SessionDB } = await import(join(PKG_SESSION, "db.js"));
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);
    const resume = db.getResume(sessionId);
    const stats = db.getSessionStats(sessionId);
    const events = db.getEvents(sessionId);

    let snapshot = null;
    if (resume && !resume.consumed) {
      snapshot = resume.snapshot;
      db.markResumeConsumed(sessionId);
    }

    if (events.length > 0) {
      additionalContext += buildSessionKnowledge("compact", events, snapshot, stats);
    }

    db.close();
  } else if (source === "startup") {
    // Fresh session — inject previous session knowledge + cleanup
    const { SessionDB } = await import(join(PKG_SESSION, "db.js"));
    const { buildResumeSnapshot } = await import(join(PKG_SESSION, "snapshot.js"));
    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });

    // Find the most recent session with events
    const recentSession = db.db.prepare(
      `SELECT m.session_id, m.event_count, m.compact_count
       FROM session_meta m
       WHERE m.event_count > 0
       ORDER BY m.started_at DESC LIMIT 1`
    ).get();

    if (recentSession) {
      const prevId = recentSession.session_id;
      const events = db.getEvents(prevId);

      if (events.length > 0) {
        // Try existing resume snapshot, else build fresh
        const resume = db.getResume(prevId);
        const snapshot = resume?.snapshot || buildResumeSnapshot(events, {
          compactCount: recentSession.compact_count ?? 0,
        });
        const stats = db.getSessionStats(prevId);

        additionalContext += buildSessionKnowledge("startup", events, snapshot, stats);
      }
    }

    db.cleanupOldSessions();
    db.close();
  }
  // "resume" and "clear" — no action needed
} catch {
  // Session continuity is best-effort — never block session start
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
}));
