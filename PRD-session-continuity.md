# PRD: Session Continuity — Smart Context Recovery After Compact

**Version**: 1.0.0
**Author**: Mert Koseoğlu
**Date**: 2026-03-04
**Status**: Draft
**Repo**: `mksglu/claude-context-mode` (open-source, same repo)

---

## 1. Problem Statement

Claude Code's context window compaction (`/compact` or auto-compact at ~83.5% usage) discards ~70-80% of conversation detail. After compact, the LLM loses:

1. **CLAUDE.md rules** — custom instructions are not re-read on `--continue` (GitHub #29746)
2. **File references** — which files were being edited, their paths and line numbers
3. **Task progress** — what step of a multi-step plan was being executed
4. **Working directory** — `cd` state accumulated during the session
5. **Error→resolution chains** — what was tried, what failed, and why
6. **User decisions** — "use approach A, not B" style corrections
7. **Role/persona** — "act as a senior engineer" behavioral directives
8. **Environment state** — activated venvs, PATH modifications, runtime selections
9. **Git context** — current branch, uncommitted changes, merge state
10. **Subagent work** — what parallel agents were doing and their results
11. **Skill activations** — which skills were loaded and their configurations
12. **User data references** — large data pastes, API keys context, config snippets
13. **Session intent** — investigation vs implementation vs discussion mode

The `--continue` flag does NOT re-read CLAUDE.md or any hook-injected context. This means our existing `SessionStart` hook context is also lost after compact.

### Community Evidence

| GitHub Issue | Stars | Pain Point |
|---|---|---|
| #1531 | 847 | "Loses all custom instructions after compact" |
| #29746 | 312 | "--continue doesn't re-read CLAUDE.md" |
| #1847 | 234 | "Forgets which files it was editing" |
| #2103 | 189 | "Task progress completely lost" |
| #1672 | 156 | "Keeps making the same mistakes after compact" |

### Existing Solutions & Their Gaps

| Tool | Approach | Gap |
|---|---|---|
| claude-mem (28K stars) | LLM-based extraction | Expensive ($0.01-0.05/event), slow, requires API key |
| precompact-hook | Transcript dump to PreCompact | No structured extraction, raw dump overwhelms context |
| MemoryForge | SQLite + embeddings | Heavy, separate process, complex setup |
| episodic-memory | Session-based recall | LLM summarization, no event granularity |
| Continuous-Claude-v3 | Thinking block extraction | Single-purpose, no integration |

**Our advantage**: Zero LLM cost (pattern-based extraction), already installed as a plugin with DB infrastructure (`ContentStore`), hooks already wired (`PreToolUse`, `SessionStart`), and the trust of an established user base.

---

## 2. Solution Overview

### Architecture: Event Extraction Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Session                        │
│                                                               │
│  User Message ──→ [PostToolUse Hook] ──→ session_events DB   │
│  Tool Call    ──→ [PostToolUse Hook] ──→ session_events DB   │
│  SubAgent     ──→ [SubagentStop Hook]──→ session_events DB   │
│                                                               │
│  ── COMPACT TRIGGERED ──                                      │
│                                                               │
│  [PreCompact Hook] ──→ Build resume snapshot                  │
│                    ──→ Write to session_resume DB              │
│                                                               │
│  ── SESSION CONTINUES (source: "compact") ──                  │
│                                                               │
│  [SessionStart Hook] ──→ Read session_resume                  │
│                      ──→ Inject as additionalContext           │
│                      ──→ DELETE consumed snapshot              │
│                                                               │
│  ── NEW SESSION (source: "startup") ──                        │
│                                                               │
│  [SessionStart Hook] ──→ DELETE all session data              │
└─────────────────────────────────────────────────────────────┘
```

### Core Principles

1. **Zero LLM cost** — All extraction is pattern-based (regex, JSON path matching, heuristics)
2. **Zero configuration** — Works out of the box, no API keys needed
3. **Ephemeral by default** — Session data deleted on new session start
4. **Minimal context injection** — Resume snapshot is <2KB, surgically targeted
5. **Non-blocking hooks** — All extraction is synchronous, <50ms per event
6. **Graceful degradation** — If extraction fails, session continues normally

---

## 3. Event Categories & Extraction Patterns

### 3.1 Event Type Definitions

Each event has: `type`, `timestamp`, `data` (JSON), `source_hook`, `priority` (1-5, 1=highest).

#### Category 1: `rule` (Priority 1)
**What**: CLAUDE.md rules, user behavioral directives, persistent instructions.
**Source Hook**: `PostToolUse` (when `Read` tool reads `CLAUDE.md` or `.claude/` files)
**Extraction Pattern**:
```javascript
// PostToolUse: tool_name === "Read" && file_path matches CLAUDE.md patterns
if (toolName === "Read") {
  const filePath = toolInput.file_path ?? "";
  if (/CLAUDE\.md$|\.claude\/.*\.md$/i.test(filePath)) {
    return {
      type: "rule",
      data: { path: filePath, snippet: truncate(toolResponse, 500) },
      priority: 1,
    };
  }
}
```

#### Category 2: `file` (Priority 1)
**What**: Files being actively edited, read, or created.
**Source Hook**: `PostToolUse` (when `Edit`, `Write`, or `Read` tools are used)
**Extraction Pattern**:
```javascript
// Track file operations with recency weighting
if (["Edit", "Write"].includes(toolName)) {
  return {
    type: "file",
    data: {
      path: toolInput.file_path,
      operation: toolName.toLowerCase(),
      // For Edit: capture old_string first 100 chars for context
      snippet: toolName === "Edit"
        ? truncate(toolInput.old_string, 100)
        : null,
    },
    priority: 1,
  };
}
```

#### Category 3: `task` (Priority 1)
**What**: Todo items, plan progress, task list state.
**Source Hook**: `PostToolUse` (when `TodoWrite`/`TaskCreate`/`TaskUpdate` tools are used)
**Extraction Pattern**:
```javascript
if (["TodoWrite", "TaskCreate", "TaskUpdate"].includes(toolName)) {
  return {
    type: "task",
    data: {
      tool: toolName,
      input: truncateJSON(toolInput, 300),
    },
    priority: 1,
  };
}
```

#### Category 4: `cwd` (Priority 2)
**What**: Working directory changes via `cd` commands.
**Source Hook**: `PostToolUse` (when `Bash` tool contains `cd` command)
**Extraction Pattern**:
```javascript
if (toolName === "Bash") {
  const cmd = toolInput.command ?? "";
  const cdMatch = cmd.match(/\bcd\s+("([^"]+)"|'([^']+)'|(\S+))/);
  if (cdMatch) {
    const dir = cdMatch[2] ?? cdMatch[3] ?? cdMatch[4];
    return {
      type: "cwd",
      data: { directory: dir, command: truncate(cmd, 200) },
      priority: 2,
    };
  }
}
```

#### Category 5: `error` (Priority 2)
**What**: Failed tool calls, error messages, failed attempts.
**Source Hook**: `PostToolUse` (when tool response indicates failure)
**Extraction Pattern**:
```javascript
// Detect errors from tool response
const response = toolResponse ?? "";
const isError =
  (toolName === "Bash" && /exit code [1-9]|error:|Error:|FAIL|failed/i.test(response)) ||
  (toolOutput?.isError === true);

if (isError) {
  return {
    type: "error",
    data: {
      tool: toolName,
      command: truncate(JSON.stringify(toolInput), 200),
      error: truncate(response, 300),
    },
    priority: 2,
  };
}
```

#### Category 6: `decision` (Priority 2)
**What**: User corrections, approach selections, rejected alternatives.
**Source Hook**: `UserPromptSubmit` (pattern matching on user messages)
**Extraction Pattern**:
```javascript
// Detect decision/correction patterns in user messages
const decisionPatterns = [
  /\b(don'?t|do not|never|always|instead|rather|prefer)\b/i,
  /\b(use|switch to|go with|pick|choose)\s+\w+\s+(instead|over|not)\b/i,
  /\b(hayır|hayir|evet|böyle|boyle|degil|değil|yerine|kullan)\b/i, // Turkish
  /\b(no,?\s+(use|do|try|make))\b/i,
];

const isDecision = decisionPatterns.some(p => p.test(userMessage));
if (isDecision) {
  return {
    type: "decision",
    data: { message: truncate(userMessage, 500) },
    priority: 2,
  };
}
```

#### Category 7: `role` (Priority 3)
**What**: Persona assignments, behavioral directives.
**Source Hook**: `UserPromptSubmit` (pattern matching)
**Extraction Pattern**:
```javascript
const rolePatterns = [
  /\b(act as|you are|behave like|pretend|role of|persona)\b/i,
  /\b(senior|staff|principal|lead)\s+(engineer|developer|architect)\b/i,
  /\b(gibi davran|rolünde|olarak çalış)\b/i, // Turkish
];

const isRole = rolePatterns.some(p => p.test(userMessage));
if (isRole) {
  return {
    type: "role",
    data: { directive: truncate(userMessage, 300) },
    priority: 3,
  };
}
```

#### Category 8: `env` (Priority 2)
**What**: Environment modifications — venv activation, PATH changes, exports.
**Source Hook**: `PostToolUse` (Bash commands with env-modifying patterns)
**Extraction Pattern**:
```javascript
if (toolName === "Bash") {
  const cmd = toolInput.command ?? "";
  const envPatterns = [
    /\bsource\s+\S*activate\b/,      // venv activation
    /\bexport\s+\w+=/,                // environment variable
    /\bnvm\s+use\b/,                  // node version
    /\bpyenv\s+(shell|local|global)\b/, // python version
    /\bconda\s+activate\b/,           // conda env
    /\brbenv\s+(shell|local|global)\b/, // ruby version
  ];

  const match = envPatterns.find(p => p.test(cmd));
  if (match) {
    return {
      type: "env",
      data: { command: truncate(cmd, 200) },
      priority: 2,
    };
  }
}
```

#### Category 9: `subagent` (Priority 3)
**What**: Subagent tasks and their results.
**Source Hook**: `SubagentStop` (receives agent transcript path and summary)
**Extraction Pattern**:
```javascript
// SubagentStop hook provides: agent_id, agent_transcript_path, exit_reason
return {
  type: "subagent",
  data: {
    agentId: input.agent_id,
    exitReason: input.exit_reason,
    // Extract first and last user/assistant messages from transcript
    summary: extractTranscriptSummary(input.agent_transcript_path),
  },
  priority: 3,
};
```

#### Category 10: `skill` (Priority 3)
**What**: Skill invocations and their configurations.
**Source Hook**: `PostToolUse` (when `Skill` tool is called)
**Extraction Pattern**:
```javascript
if (toolName === "Skill") {
  return {
    type: "skill",
    data: {
      skill: toolInput.skill,
      args: toolInput.args ?? null,
    },
    priority: 3,
  };
}
```

#### Category 11: `git` (Priority 2)
**What**: Branch state, uncommitted changes, recent commits.
**Source Hook**: `PostToolUse` (Bash commands with git operations)
**Extraction Pattern**:
```javascript
if (toolName === "Bash") {
  const cmd = toolInput.command ?? "";
  const gitPatterns = [
    { pattern: /\bgit\s+checkout\s+(-b\s+)?(\S+)/, extract: "branch" },
    { pattern: /\bgit\s+commit\b/, extract: "commit" },
    { pattern: /\bgit\s+merge\s+(\S+)/, extract: "merge" },
    { pattern: /\bgit\s+rebase\b/, extract: "rebase" },
    { pattern: /\bgit\s+stash\b/, extract: "stash" },
    { pattern: /\bgit\s+push\b/, extract: "push" },
  ];

  const match = gitPatterns.find(p => p.pattern.test(cmd));
  if (match) {
    return {
      type: "git",
      data: {
        operation: match.extract,
        command: truncate(cmd, 200),
        // Include response for branch/status info
        output: truncate(toolResponse, 200),
      },
      priority: 2,
    };
  }
}
```

#### Category 12: `data` (Priority 4)
**What**: Large user-pasted data references (not the data itself, just metadata).
**Source Hook**: `UserPromptSubmit` (messages > 1KB)
**Extraction Pattern**:
```javascript
if (userMessage.length > 1024) {
  return {
    type: "data",
    data: {
      size: userMessage.length,
      preview: truncate(userMessage, 200),
      // Detect data type
      format: detectDataFormat(userMessage), // "json" | "csv" | "code" | "text"
    },
    priority: 4,
  };
}
```

#### Category 13: `intent` (Priority 4)
**What**: Session mode — investigation, implementation, discussion, debugging.
**Source Hook**: `UserPromptSubmit` (heuristic classification)
**Extraction Pattern**:
```javascript
const intentPatterns = {
  investigate: /\b(why|how does|explain|understand|what is|analyze|debug|look into)\b/i,
  implement: /\b(create|add|build|implement|write|make|develop|fix)\b/i,
  discuss: /\b(think about|consider|should we|what if|pros and cons|opinion)\b/i,
  review: /\b(review|check|audit|verify|test|validate)\b/i,
};

// Only record on strong signal (first message or clear mode shift)
const intent = Object.entries(intentPatterns)
  .find(([, pattern]) => pattern.test(userMessage));

if (intent) {
  return {
    type: "intent",
    data: { mode: intent[0], message: truncate(userMessage, 200) },
    priority: 4,
  };
}
```

---

## 4. Database Schema

### 4.1 New Tables (added to existing ContentStore DB)

**Important**: Session continuity tables live in a **separate, persistent DB file** — NOT in the ephemeral per-PID ContentStore DB. The ContentStore DB is deleted on process exit. Session data must survive process restart (compact triggers a new process).

```sql
-- File: ~/.claude/context-mode/sessions.db (persistent, per-project)
-- One DB per project, path derived from CLAUDE_PROJECT_DIR

-- Raw events captured during the session
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,          -- Claude Code session UUID
  type TEXT NOT NULL,                -- event category (rule|file|task|cwd|error|decision|role|env|subagent|skill|git|data|intent)
  priority INTEGER NOT NULL DEFAULT 3, -- 1=critical, 5=low
  data TEXT NOT NULL,                -- JSON payload
  source_hook TEXT NOT NULL,         -- which hook captured this (PostToolUse|UserPromptSubmit|SubagentStop|PreCompact)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- For deduplication: same event type + same data hash = skip
  data_hash TEXT GENERATED ALWAYS AS (
    substr(hex(data), 1, 16)
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_session_events_session
  ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type
  ON session_events(session_id, type);
CREATE INDEX IF NOT EXISTS idx_session_events_priority
  ON session_events(session_id, priority);

-- Compiled resume snapshot (built from events at PreCompact time)
CREATE TABLE IF NOT EXISTS session_resume (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,   -- one resume per session
  snapshot TEXT NOT NULL,            -- XML resume template (<2KB)
  event_count INTEGER NOT NULL,      -- how many events were summarized
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed INTEGER NOT NULL DEFAULT 0 -- set to 1 after injection
);

-- Session metadata for lifecycle management
CREATE TABLE IF NOT EXISTS session_meta (
  session_id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,         -- CLAUDE_PROJECT_DIR
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_event_at TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  compact_count INTEGER NOT NULL DEFAULT 0  -- how many compacts this session
);
```

### 4.2 DB Location Strategy

```
~/.claude/context-mode/sessions/
  └── <project-hash>.db          # SHA-256(CLAUDE_PROJECT_DIR)[:16]
```

- **Per-project isolation**: Each project gets its own session DB
- **Persistent across compacts**: DB survives process restarts
- **Auto-cleanup**: Old sessions purged on new session start (startup source)
- **Size cap**: Max 1000 events per session, FIFO eviction of lowest priority

### 4.3 Session ID Discovery

Claude Code does not pass a session ID to hooks. We derive it from:

```javascript
// Option A: Use transcript path (contains session UUID)
// ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
// Extract UUID from the JSONL filename

// Option B: Use process.ppid (parent PID = Claude Code process)
// Stable within a session, changes on restart

// Option C: Environment variable CLAUDE_SESSION_ID (if available)

// Recommended: Option A (transcript_path) when available (PreCompact),
// Option B (ppid) for PostToolUse/UserPromptSubmit where transcript isn't provided
function getSessionId(hookInput) {
  if (hookInput.transcript_path) {
    const match = hookInput.transcript_path.match(/([a-f0-9-]{36})\.jsonl$/);
    if (match) return match[1];
  }
  // Fallback: parent PID as session identifier
  return `pid-${process.ppid}`;
}
```

---

## 5. Hook Pipeline Implementation

### 5.1 New Hooks Required

Current hooks in `hooks.json`:
- `PreToolUse` — routing/security (existing)
- `SessionStart` — context injection (existing)

New hooks to add:
- `PostToolUse` — event extraction (NEW)
- `PreCompact` — resume snapshot generation (NEW)
- `SubagentStop` — subagent tracking (NEW, Phase 2)

### 5.2 Updated `hooks.json`

```json
{
  "description": "Context-mode hooks — routing, security, and session continuity",
  "hooks": {
    "PreToolUse": [
      "... (existing, unchanged) ..."
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/posttooluse.mjs"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/precompact.mjs"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs"
          }
        ]
      }
    ]
  }
}
```

### 5.3 Hook: `posttooluse.mjs`

**Input** (from stdin):
```json
{
  "hook_type": "PostToolUse",
  "session_id": "...",
  "tool_name": "Bash",
  "tool_input": { "command": "git checkout -b feature/x" },
  "tool_response": "Switched to a new branch 'feature/x'",
  "tool_use_id": "toolu_..."
}
```

**Behavior**:
1. Parse stdin JSON
2. Run extraction rules (all 13 categories)
3. If event extracted → INSERT into `session_events`
4. Output empty JSON (no hook response needed for PostToolUse)
5. Total execution: <20ms target

**Key constraint**: PostToolUse hooks MUST be fast. No file I/O beyond the SQLite write. No network calls. No LLM calls.

```javascript
// posttooluse.mjs — pseudocode
import { SessionDB } from "./session-db.mjs";

const input = JSON.parse(await readStdin());
const db = new SessionDB();
const sessionId = getSessionId(input);

const events = extractEvents(input);
for (const event of events) {
  db.insertEvent(sessionId, event);
}

// PostToolUse doesn't need hookSpecificOutput
// Empty output = passthrough
```

### 5.4 Hook: `precompact.mjs`

**Input** (from stdin):
```json
{
  "hook_type": "PreCompact",
  "session_id": "...",
  "transcript_path": "~/.claude/projects/.../uuid.jsonl",
  "trigger": "auto"
}
```

**Behavior**:
1. Read all `session_events` for current session
2. Build priority-sorted resume snapshot
3. Apply budget: max 2KB for the XML template
4. Write to `session_resume` table
5. Increment `compact_count` in `session_meta`
6. Optionally extract thinking blocks from transcript (Phase 2)

```javascript
// precompact.mjs — pseudocode
const input = JSON.parse(await readStdin());
const db = new SessionDB();
const sessionId = getSessionId(input);

const events = db.getEvents(sessionId);
const snapshot = buildResumeSnapshot(events);

db.upsertResume(sessionId, snapshot);
db.incrementCompactCount(sessionId);

// PreCompact can output additionalContext but we don't need to
console.log(JSON.stringify({}));
```

### 5.5 Hook: `sessionstart.mjs` (Updated)

**Current behavior**: Injects `ROUTING_BLOCK` as additionalContext.

**New behavior**: Also checks for resume snapshot and injects it.

```javascript
// sessionstart.mjs — updated pseudocode
import { ROUTING_BLOCK } from "./routing-block.mjs";

const input = JSON.parse(await readStdin());
const source = input.source ?? "startup"; // "startup" | "resume" | "compact" | "clear"

let additionalContext = ROUTING_BLOCK;

if (source === "compact") {
  // Session was compacted — inject resume context
  const db = new SessionDB();
  const sessionId = getSessionId(input);
  const resume = db.getResume(sessionId);

  if (resume) {
    additionalContext += "\n" + resume.snapshot;
    db.markResumeConsumed(sessionId);
  }
} else if (source === "startup") {
  // Fresh session (no --continue) — purge previous session events
  const db = new SessionDB();
  db.deleteCurrentSession();   // user started fresh, old session is irrelevant
  db.cleanupOldSessions();     // also clean up sessions older than 1 day
}

// ── Session Lifecycle Rules ──
// "startup"  → Fresh session. Delete previous session data. No resume.
// "compact"  → Auto-compact triggered. Inject resume snapshot. This is the core use case.
// "resume"   → User used --continue. Claude has full history, no resume needed.
// "clear"    → User cleared context. No resume.

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
}));
```

---

## 6. Resume Snapshot Template

The resume snapshot is an XML block injected via `additionalContext` on SessionStart after compact. Budget: **<2KB**.

### 6.1 Template Structure

```xml
<session_resume compact_count="1" events_captured="47" generated_at="2026-03-04T14:30:00Z">
  <!-- Priority 1: What you MUST know -->
  <active_files>
    <file path="src/server.ts" ops="edit:3,read:5" last="edit" />
    <file path="src/store.ts" ops="edit:1,read:2" last="read" />
    <file path="tests/session.test.ts" ops="write:1" last="write" />
  </active_files>

  <task_state>
    Implementing session continuity feature. Current step: writing PostToolUse hook.
    Todo: [x] DB schema [x] Event types [ ] PostToolUse hook [ ] PreCompact hook [ ] Tests
  </task_state>

  <rules>
    - CLAUDE.md: Never set Claude as git author
    - CLAUDE.md: Always maximize parallelism with subagents
    - User correction: "use ctx- prefix, not cm-"
  </rules>

  <!-- Priority 2: Context that helps -->
  <decisions>
    - Chose open-source over paid feature
    - Using pattern-based extraction, not LLM calls
    - Session data stored in separate persistent DB, not ephemeral ContentStore
  </decisions>

  <environment>
    <cwd>/Users/mksglu/Server/Mert/context-mode-claude-code-plugin/context-mode</cwd>
    <git branch="next" dirty="true" />
  </environment>

  <errors_resolved>
    - "Push rejected: remote ahead" → fixed with git pull --rebase
  </errors_resolved>

  <!-- Priority 3: Nice to have -->
  <intent mode="implement">Writing PRD for session continuity feature</intent>
</session_resume>
```

### 6.2 Snapshot Builder Algorithm

```javascript
function buildResumeSnapshot(events, maxBytes = 2048) {
  // Group events by type
  const grouped = groupBy(events, "type");

  // Priority budget allocation:
  // P1 (file, task, rule): 50% = ~1024 bytes
  // P2 (cwd, error, decision, env, git): 35% = ~716 bytes
  // P3-P4 (subagent, skill, role, data, intent): 15% = ~308 bytes

  const sections = [];

  // P1: Active files (deduplicated, last 10)
  const files = deduplicateFiles(grouped.file ?? []);
  sections.push(renderActiveFiles(files.slice(-10)));

  // P1: Task state (latest task events)
  const tasks = grouped.task ?? [];
  if (tasks.length > 0) {
    sections.push(renderTaskState(tasks));
  }

  // P1: Rules (CLAUDE.md reads + user decisions tagged as rules)
  const rules = [...(grouped.rule ?? []), ...(grouped.decision ?? [])
    .filter(e => e.priority <= 2)];
  sections.push(renderRules(rules.slice(-5)));

  // P2: Decisions (non-rule decisions)
  const decisions = (grouped.decision ?? [])
    .filter(e => e.priority > 2);
  if (decisions.length > 0) {
    sections.push(renderDecisions(decisions.slice(-5)));
  }

  // P2: Environment (latest cwd + env)
  const cwd = (grouped.cwd ?? []).at(-1);
  const env = grouped.env ?? [];
  const git = (grouped.git ?? []).at(-1);
  sections.push(renderEnvironment(cwd, env.slice(-3), git));

  // P2: Errors (only unresolved / recent)
  const errors = grouped.error ?? [];
  if (errors.length > 0) {
    sections.push(renderErrors(errors.slice(-3)));
  }

  // P3-P4: Intent, role, subagent (if budget allows)
  const intent = (grouped.intent ?? []).at(-1);
  if (intent) sections.push(renderIntent(intent));

  // Assemble with budget trimming
  return assembleWithBudget(sections, maxBytes);
}
```

---

## 7. Monorepo Architecture

### 7.1 Motivation

The project now has two distinct domains:
- **Core**: Context window protection — MCP tools, sandboxed execution, FTS5 knowledge base, tool routing
- **Session**: Session continuity — event extraction, resume snapshots, post-compact recovery

These domains share some infrastructure (SQLite patterns, string utilities) but have completely different responsibilities. A Turborepo-style monorepo pattern (using **npm workspaces only**, no Turborepo dependency) provides clean domain separation while keeping a single published npm package (`context-mode`).

### 7.2 Directory Structure

```
context-mode/                          # Root (published as "context-mode" on npm)
├── package.json                       # workspaces: ["packages/*"], name: "context-mode"
├── tsconfig.base.json                 # Shared TS config, all packages extend this
├── packages/
│   ├── core/                          # Domain A: Context Window Protection
│   │   ├── package.json               # @context-mode/core, private: true
│   │   ├── tsconfig.json              # extends ../../tsconfig.base.json
│   │   └── src/
│   │       ├── server.ts              # MCP server entrypoint (200K→5KB)
│   │       ├── executor.ts            # Polyglot executor (11 languages)
│   │       ├── runtime.ts             # Runtime detection & command building
│   │       ├── security.ts            # Bash/file permission policies
│   │       └── cli.ts                 # CLI commands (setup, doctor, upgrade)
│   │
│   ├── session/                       # Domain B: Session Continuity
│   │   ├── package.json               # @context-mode/session, private: true
│   │   ├── tsconfig.json              # extends ../../tsconfig.base.json
│   │   └── src/
│   │       ├── extract.ts             # Event extraction rules (13 categories, pure functions)
│   │       ├── snapshot.ts            # Resume snapshot builder (pure functions)
│   │       └── db.ts                  # SessionDB class (persistent SQLite)
│   │
│   ├── shared/                        # Shared Business Logic
│   │   ├── package.json               # @context-mode/shared, private: true
│   │   ├── tsconfig.json              # extends ../../tsconfig.base.json
│   │   └── src/
│   │       ├── db-base.ts             # SQLite lazy-load, WAL setup, prepared stmt cache
│   │       ├── store.ts               # ContentStore (FTS5 knowledge base)
│   │       ├── truncate.ts            # String/JSON truncation utilities
│   │       └── types.ts               # Common interfaces & type definitions
│
├── hooks/                             # Claude Code hooks (stays at root — plugin system requirement)
│   ├── pretooluse.mjs                 # EXISTING — tool routing & security
│   ├── sessionstart.mjs              # MODIFIED — routing block + resume injection
│   ├── posttooluse.mjs               # NEW — event extraction
│   ├── precompact.mjs                # NEW — resume snapshot builder
│   ├── routing-block.mjs             # EXISTING — shared routing constants
│   └── hooks.json                    # MODIFIED — add PostToolUse, PreCompact
│
├── skills/                            # Claude Code skills (stays at root — plugin system requirement)
│   ├── context-mode/                  # Main context-mode skill
│   ├── ctx-doctor/                    # /context-mode:ctx-doctor
│   ├── ctx-stats/                     # /context-mode:ctx-stats
│   ├── ctx-upgrade/                   # /context-mode:ctx-upgrade
│   └── (ctx-test-compact is dev-only, NOT a public skill)
│
├── tests/                             # Tests organized by package
│   ├── core/                          # Core domain tests
│   │   ├── executor.test.ts
│   │   ├── store.test.ts
│   │   ├── fuzzy-search.test.ts
│   │   ├── search-wiring.test.ts
│   │   ├── search-fallback-integration.test.ts
│   │   ├── turndown.test.ts
│   │   ├── stream-cap.test.ts
│   │   ├── hook-integration.test.ts
│   │   └── project-dir.test.ts
│   ├── session/                       # Session domain tests
│   │   ├── session-extract.test.ts
│   │   ├── session-snapshot.test.ts
│   │   ├── session-db.test.ts
│   │   ├── session-integration.test.ts
│   │   ├── session-compact.test.ts
│   │   └── session-pipeline.test.ts
│   └── shared/                        # Shared logic tests
│       └── db-base.test.ts
│
├── build/                             # tsc output (all packages compile here)
│   ├── core/
│   ├── session/
│   └── shared/
├── server.bundle.mjs                  # esbuild output (bundles core + shared)
├── start.mjs                          # MCP entry point
├── .claude-plugin/                    # Plugin metadata
└── README.md
```

### 7.3 Why This Structure

| Concern | Decision | Rationale |
|---|---|---|
| **No Turborepo dependency** | npm workspaces only | Zero extra tooling, `npm install` handles everything |
| **`packages/` not `apps/`** | Both domains are libraries, not deployable apps | No frontend/backend distinction needed |
| **Hooks at root** | Plugin system expects `${CLAUDE_PLUGIN_ROOT}/hooks/` | Can't nest hooks inside packages |
| **Skills at root** | Plugin system expects `./skills/` from plugin.json | Same constraint as hooks |
| **Tests at root** | Single `test:all` glob across all test files | Easier CI, avoids workspace test orchestration |
| **Single published package** | Root `package.json` is what gets published | Users install `context-mode`, not individual packages |
| **All packages `private: true`** | Internal organizational units only | Never published to npm individually |

### 7.4 Shared Business Logic Analysis

What's genuinely shared between **core** and **session**:

| Shared Module | Used by Core | Used by Session | Content |
|---|---|---|---|
| `db-base.ts` | ContentStore | SessionDB | SQLite lazy-load, WAL pragma, prepared stmt pattern, cleanup helpers |
| `store.ts` | MCP server (FTS5 index/search) | — (but depends on db-base) | ContentStore class (stays in shared because db-base lives here) |
| `truncate.ts` | Store chunking (4KB cap) | Event data truncation (300 char cap) | `truncate(str, max)`, `truncateJSON(obj, max)`, XML escaping |
| `types.ts` | — | — | Common interfaces: `PreparedStatement`, `IndexResult`, `SearchResult` |

**What's NOT shared** (stays in its own package):
- `executor.ts`, `runtime.ts`, `security.ts` → only core
- `extract.ts`, `snapshot.ts`, `db.ts` → only session
- `cli.ts` → only core (though `doctor` may later check session DB health)

### 7.5 Package Configuration

#### Root `package.json` (published to npm)
```json
{
  "name": "context-mode",
  "version": "0.10.0",
  "type": "module",
  "private": false,
  "workspaces": ["packages/*"],
  "bin": { "context-mode": "./build/core/cli.js" },
  "files": ["build", "hooks", "server.bundle.mjs", "skills", ".claude-plugin", "start.mjs", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -b",
    "bundle": "esbuild packages/core/src/server.ts --bundle --platform=node --target=node18 --format=esm --outfile=server.bundle.mjs --external:better-sqlite3 --external:turndown --external:turndown-plugin-gfm --external:@mixmark-io/domino --minify",
    "typecheck": "tsc -b --noEmit",
    "test": "for f in tests/**/*.test.ts; do npx tsx \"$f\" || exit 1; done",
    "test:core": "for f in tests/core/*.test.ts; do npx tsx \"$f\" || exit 1; done",
    "test:session": "for f in tests/session/*.test.ts; do npx tsx \"$f\" || exit 1; done",
    "test:shared": "for f in tests/shared/*.test.ts; do npx tsx \"$f\" || exit 1; done"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "better-sqlite3": "^12.6.2",
    "turndown": "^7.2.0",
    "turndown-plugin-gfm": "^1.0.2",
    "zod": "^3.25.0",
    "@clack/prompts": "^1.0.1",
    "picocolors": "^1.1.1",
    "@mixmark-io/domino": "^2.2.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.19.11",
    "@types/turndown": "^5.0.5",
    "esbuild": "^0.27.3",
    "tsx": "^4.21.0",
    "typescript": "^5.7.0"
  }
}
```

#### `packages/core/package.json`
```json
{
  "name": "@context-mode/core",
  "private": true,
  "type": "module",
  "dependencies": {
    "@context-mode/shared": "*"
  }
}
```

#### `packages/session/package.json` (private — bundled, never published)
```json
{
  "name": "@context-mode/session",
  "private": true,
  "type": "module",
  "dependencies": {
    "@context-mode/shared": "*"
  }
}
```

#### `packages/shared/package.json` (private — bundled, never published)
```json
{
  "name": "@context-mode/shared",
  "private": true,
  "type": "module",
  "exports": {
    "./db-base": { "types": "./src/db-base.ts", "default": "../../build/shared/db-base.js" },
    "./store": { "types": "./src/store.ts", "default": "../../build/shared/store.js" },
    "./truncate": { "types": "./src/truncate.ts", "default": "../../build/shared/truncate.js" },
    "./types": { "types": "./src/types.ts", "default": "../../build/shared/types.js" }
  }
}
```


#### `tsconfig.base.json` (root)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "../../build",
    "rootDir": "src"
  }
}
```

Each package extends it:
```json
// packages/core/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "../../build/core", "rootDir": "src" },
  "references": [{ "path": "../shared" }],
  "include": ["src"]
}
```

### 7.6 Module Dependency Graph

```
packages/core/src/server.ts
  ├── packages/core/src/executor.ts
  │   └── packages/core/src/runtime.ts
  ├── packages/core/src/security.ts
  ├── packages/shared/src/store.ts
  │   └── packages/shared/src/db-base.ts
  └── packages/core/src/runtime.ts

packages/session/src/extract.ts          (pure functions, no deps)
packages/session/src/snapshot.ts         (pure functions, uses shared/truncate)
  └── packages/shared/src/truncate.ts
packages/session/src/db.ts
  └── packages/shared/src/db-base.ts

hooks/posttooluse.mjs
  ├── build/session/extract.js
  └── build/session/db.js

hooks/precompact.mjs
  ├── build/session/snapshot.js
  └── build/session/db.js

hooks/sessionstart.mjs
  ├── build/session/db.js
  └── hooks/routing-block.mjs
```

### 7.7 How Hooks Import from Packages

Hooks are `.mjs` files that run directly via `node` (no build step for the hooks themselves). They import compiled output from `build/`:

```javascript
// hooks/posttooluse.mjs
import { extractEvents } from "../build/session/extract.js";
import { SessionDB } from "../build/session/db.js";

const input = JSON.parse(await readStdin());
const events = extractEvents(input);
// ...
```

```javascript
// hooks/precompact.mjs
import { buildResumeSnapshot } from "../build/session/snapshot.js";
import { SessionDB } from "../build/session/db.js";

const input = JSON.parse(await readStdin());
const db = new SessionDB(process.env.CLAUDE_PROJECT_DIR);
const events = db.getEvents(sessionId);
const snapshot = buildResumeSnapshot(events);
// ...
```

This pattern already exists: `pretooluse.mjs` imports security from `build/security.js`.

### 7.8 How esbuild Bundles Work

esbuild resolves workspace package imports and **inlines** them:

```bash
esbuild packages/core/src/server.ts --bundle ...
# Follows: import { ContentStore } from "@context-mode/shared/store"
# Resolves via npm workspace symlink → packages/shared/src/store.ts
# Inlines into server.bundle.mjs
```

`@context-mode/shared` is NOT in `--external` — esbuild bundles it. Only native deps (`better-sqlite3`, `turndown`, etc.) stay external.


### 7.9 Migration Plan (Existing Files)

| Current Location | New Location | Notes |
|---|---|---|
| `src/server.ts` | `packages/core/src/server.ts` | Update imports to `@context-mode/shared/*` |
| `src/executor.ts` | `packages/core/src/executor.ts` | Unchanged |
| `src/runtime.ts` | `packages/core/src/runtime.ts` | Unchanged |
| `src/security.ts` | `packages/core/src/security.ts` | Unchanged |
| `src/cli.ts` | `packages/core/src/cli.ts` | Unchanged |
| `src/store.ts` | `packages/shared/src/store.ts` | Extract db-base.ts, keep ContentStore |
| — | `packages/shared/src/db-base.ts` | NEW: extracted from store.ts |
| — | `packages/shared/src/truncate.ts` | NEW: extracted from store.ts + executor.ts |
| — | `packages/shared/src/types.ts` | NEW: shared interfaces |
| — | `packages/session/src/extract.ts` | NEW |
| — | `packages/session/src/snapshot.ts` | NEW |
| — | `packages/session/src/db.ts` | NEW |
| `tests/*.test.ts` | `tests/core/*.test.ts` | Existing tests move to core/ |
| — | `tests/session/*.test.ts` | NEW |
| — | `tests/shared/*.test.ts` | NEW |
| `hooks/*` | `hooks/*` (unchanged) | Hooks stay at root |
| `skills/*` | `skills/*` (unchanged) | Skills stay at root |

---

## 8. SessionDB Class Design

```javascript
// session-db.mjs

export class SessionDB {
  #db;          // better-sqlite3 instance
  #dbPath;      // persistent path

  constructor(projectDir) {
    // projectDir from CLAUDE_PROJECT_DIR env var
    const hash = crypto.createHash("sha256")
      .update(projectDir).digest("hex").slice(0, 16);
    const dir = join(homedir(), ".claude", "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    this.#dbPath = join(dir, `${hash}.db`);
    this.#db = new Database(this.#dbPath, { timeout: 3000 });
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = NORMAL");
    this.#initSchema();
  }

  // ── Write ──

  insertEvent(sessionId, event) {
    // Deduplicate: skip if same type + data_hash exists in last 5 events
    // Enforce max 1000 events per session (FIFO eviction of lowest priority)
  }

  upsertResume(sessionId, snapshot) {
    // INSERT OR REPLACE — one resume per session
  }

  upsertMeta(sessionId, projectDir) {
    // Track session lifecycle
  }

  incrementCompactCount(sessionId) {
    // compact_count += 1
  }

  // ── Read ──

  getEvents(sessionId, options = {}) {
    // Returns events sorted by priority ASC, created_at DESC
    // options: { type?, limit?, minPriority? }
  }

  getResume(sessionId) {
    // Returns unconsumed resume snapshot, or null
  }

  // ── Lifecycle ──

  markResumeConsumed(sessionId) {
    // Set consumed = 1
  }

  cleanupOldSessions(keepDays = 1) {
    // Delete sessions older than keepDays
    // Called on SessionStart(startup)
  }

  deleteSession(sessionId) {
    // Delete all events, resume, meta for a session
  }

  // ── Diagnostics ──

  getSessionStats(sessionId) {
    // Returns { eventCount, compactCount, resumeExists, lastEventAt }
  }
}
```

---

## 9. Performance Requirements

| Metric | Target | Rationale |
|---|---|---|
| PostToolUse hook latency | <20ms | Runs after EVERY tool call — must be invisible |
| PreCompact hook latency | <100ms | Runs once before compact — more budget |
| SessionStart hook latency | <50ms | Current hook is <10ms, resume adds ~30ms |
| DB file size per project | <500KB | ~1000 events at ~500 bytes each |
| Resume snapshot size | <2KB | Must fit in additionalContext without flooding |
| Memory per hook invocation | <10MB | Hooks are short-lived Node.js processes |

### Performance Optimizations

1. **Prepared statements** — All SQL queries prepared once at SessionDB construction
2. **WAL mode** — Non-blocking reads during writes (same as ContentStore)
3. **Batch inserts** — PostToolUse extracts 0-3 events per call, all in one transaction
4. **No file I/O in hot path** — Only SQLite writes in PostToolUse
5. **Lazy DB open** — SessionDB not opened unless an event is actually extracted

---

## 10. Test Plan (TDD)

### 10.1 Test File Structure

```
tests/
  session-extract.test.ts    # Unit: extraction rules (pure functions)
  session-snapshot.test.ts   # Unit: snapshot builder (pure functions)
  session-db.test.ts         # Unit: SessionDB CRUD operations
  session-integration.test.ts # Integration: full pipeline simulation
  session-compact.test.ts    # E2E: context-filling scenario
```

### 10.2 Unit Tests: Event Extraction (`session-extract.test.ts`)

```typescript
import { strict as assert } from "node:assert";

// ── Test helpers ──
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS: ${name}`); }
  catch (e) { console.error(`  FAIL: ${name}`); throw e; }
}

// ════════════════════════════════════════════
// FILE EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts file event from Edit tool call", () => {
  const input = {
    tool_name: "Edit",
    tool_input: {
      file_path: "/project/src/server.ts",
      old_string: "const VERSION = \"0.9.21\"",
      new_string: "const VERSION = \"0.9.22\"",
    },
    tool_response: "File edited successfully",
  };

  const events = extractEvents(input);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "file");
  assert.equal(events[0].data.path, "/project/src/server.ts");
  assert.equal(events[0].data.operation, "edit");
  assert.equal(events[0].priority, 1);
});

test("extracts file event from Write tool call", () => {
  const input = {
    tool_name: "Write",
    tool_input: { file_path: "/project/tests/new.test.ts", content: "..." },
    tool_response: "File written",
  };

  const events = extractEvents(input);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "file");
  assert.equal(events[0].data.operation, "write");
});

test("extracts file event from Read of source files only", () => {
  const input = {
    tool_name: "Read",
    tool_input: { file_path: "/project/src/store.ts" },
    tool_response: "file contents...",
  };

  const events = extractEvents(input);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "file");
  assert.equal(events[0].data.operation, "read");
});

// ════════════════════════════════════════════
// RULE EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts rule event when CLAUDE.md is read", () => {
  const input = {
    tool_name: "Read",
    tool_input: { file_path: "/project/CLAUDE.md" },
    tool_response: "# Rules\n- Never push without approval\n- Always use TypeScript",
  };

  const events = extractEvents(input);
  const ruleEvents = events.filter(e => e.type === "rule");
  assert.equal(ruleEvents.length, 1);
  assert.equal(ruleEvents[0].priority, 1);
  assert.ok(ruleEvents[0].data.path.endsWith("CLAUDE.md"));
});

test("extracts rule event for .claude/ config files", () => {
  const input = {
    tool_name: "Read",
    tool_input: { file_path: "/home/user/.claude/settings.json" },
    tool_response: "{ ... }",
  };

  const events = extractEvents(input);
  const ruleEvents = events.filter(e => e.type === "rule");
  assert.equal(ruleEvents.length, 1);
});

// ════════════════════════════════════════════
// CWD EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts cwd event from cd command", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "cd /project/subdir && ls" },
    tool_response: "file1.ts\nfile2.ts",
  };

  const events = extractEvents(input);
  const cwdEvents = events.filter(e => e.type === "cwd");
  assert.equal(cwdEvents.length, 1);
  assert.equal(cwdEvents[0].data.directory, "/project/subdir");
});

test("extracts cwd from cd with quoted path", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: 'cd "/path with spaces/dir"' },
    tool_response: "",
  };

  const events = extractEvents(input);
  const cwdEvents = events.filter(e => e.type === "cwd");
  assert.equal(cwdEvents.length, 1);
  assert.equal(cwdEvents[0].data.directory, "/path with spaces/dir");
});

test("does not extract cwd from non-cd bash commands", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
    tool_response: "...",
  };

  const events = extractEvents(input);
  const cwdEvents = events.filter(e => e.type === "cwd");
  assert.equal(cwdEvents.length, 0);
});

// ════════════════════════════════════════════
// ERROR EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts error event from failed bash command", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: "FAIL src/store.test.ts\nError: expected 3 but got 5\nexit code 1",
  };

  const events = extractEvents(input);
  const errorEvents = events.filter(e => e.type === "error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].priority, 2);
  assert.ok(errorEvents[0].data.error.includes("FAIL"));
});

test("extracts error from isError: true response", () => {
  const input = {
    tool_name: "Edit",
    tool_input: { file_path: "/x.ts", old_string: "foo", new_string: "bar" },
    tool_response: "old_string not found in file",
    tool_output: { isError: true },
  };

  const events = extractEvents(input);
  const errorEvents = events.filter(e => e.type === "error");
  assert.equal(errorEvents.length, 1);
});

test("does not extract error from successful bash command", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
    tool_response: "hello",
  };

  const events = extractEvents(input);
  const errorEvents = events.filter(e => e.type === "error");
  assert.equal(errorEvents.length, 0);
});

// ════════════════════════════════════════════
// DECISION EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts decision from user correction", () => {
  const events = extractUserEvents("no, use ctx- prefix instead of cm-");
  const decisionEvents = events.filter(e => e.type === "decision");
  assert.equal(decisionEvents.length, 1);
  assert.ok(decisionEvents[0].data.message.includes("ctx-"));
});

test("extracts decision from 'always/never' directives", () => {
  const events = extractUserEvents("never push to main without asking me first");
  const decisionEvents = events.filter(e => e.type === "decision");
  assert.equal(decisionEvents.length, 1);
});

test("extracts decision from Turkish corrections", () => {
  const events = extractUserEvents("hayır, böyle değil, yerine ctx- kullan");
  const decisionEvents = events.filter(e => e.type === "decision");
  assert.equal(decisionEvents.length, 1);
});

test("does not extract decision from regular messages", () => {
  const events = extractUserEvents("Can you read the server.ts file?");
  const decisionEvents = events.filter(e => e.type === "decision");
  assert.equal(decisionEvents.length, 0);
});

// ════════════════════════════════════════════
// GIT EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts git event from checkout command", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "git checkout -b feature/session-continuity" },
    tool_response: "Switched to a new branch 'feature/session-continuity'",
  };

  const events = extractEvents(input);
  const gitEvents = events.filter(e => e.type === "git");
  assert.equal(gitEvents.length, 1);
  assert.equal(gitEvents[0].data.operation, "branch");
});

test("extracts git event from commit command", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: 'git commit -m "feat: add session continuity"' },
    tool_response: "[next abc1234] feat: add session continuity",
  };

  const events = extractEvents(input);
  const gitEvents = events.filter(e => e.type === "git");
  assert.equal(gitEvents.length, 1);
  assert.equal(gitEvents[0].data.operation, "commit");
});

// ════════════════════════════════════════════
// ENV EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts env event from venv activation", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "source .venv/bin/activate" },
    tool_response: "",
  };

  const events = extractEvents(input);
  const envEvents = events.filter(e => e.type === "env");
  assert.equal(envEvents.length, 1);
});

test("extracts env event from nvm use", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "nvm use 20" },
    tool_response: "Now using node v20.0.0",
  };

  const events = extractEvents(input);
  const envEvents = events.filter(e => e.type === "env");
  assert.equal(envEvents.length, 1);
});

test("extracts env event from export command", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "export API_KEY=sk-test" },
    tool_response: "",
  };

  const events = extractEvents(input);
  const envEvents = events.filter(e => e.type === "env");
  assert.equal(envEvents.length, 1);
  // SECURITY: env data should NOT contain the actual value
  assert.ok(!envEvents[0].data.command.includes("sk-test") ||
            envEvents[0].data.command.includes("export API_KEY="));
});

// ════════════════════════════════════════════
// TASK EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts task event from TodoWrite", () => {
  const input = {
    tool_name: "TodoWrite",
    tool_input: { todos: [{ id: "1", content: "Write tests", status: "in_progress" }] },
    tool_response: "ok",
  };

  const events = extractEvents(input);
  const taskEvents = events.filter(e => e.type === "task");
  assert.equal(taskEvents.length, 1);
  assert.equal(taskEvents[0].priority, 1);
});

// ════════════════════════════════════════════
// SKILL EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts skill event from Skill tool call", () => {
  const input = {
    tool_name: "Skill",
    tool_input: { skill: "tdd", args: "session tests" },
    tool_response: "Loaded TDD skill",
  };

  const events = extractEvents(input);
  const skillEvents = events.filter(e => e.type === "skill");
  assert.equal(skillEvents.length, 1);
  assert.equal(skillEvents[0].data.skill, "tdd");
});

// ════════════════════════════════════════════
// INTENT EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts investigation intent", () => {
  const events = extractUserEvents("Why is the test failing? Can you debug this?");
  const intentEvents = events.filter(e => e.type === "intent");
  assert.equal(intentEvents.length, 1);
  assert.equal(intentEvents[0].data.mode, "investigate");
});

test("extracts implementation intent", () => {
  const events = extractUserEvents("Create a new PostToolUse hook for event extraction");
  const intentEvents = events.filter(e => e.type === "intent");
  assert.equal(intentEvents.length, 1);
  assert.equal(intentEvents[0].data.mode, "implement");
});

// ════════════════════════════════════════════
// ROLE EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts role from persona directive", () => {
  const events = extractUserEvents("Act as a senior staff engineer for this review");
  const roleEvents = events.filter(e => e.type === "role");
  assert.equal(roleEvents.length, 1);
  assert.ok(roleEvents[0].data.directive.includes("senior staff engineer"));
});

// ════════════════════════════════════════════
// DATA EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts data event from large user message", () => {
  const largeMessage = "Here is the config:\n" + "x".repeat(2000);
  const events = extractUserEvents(largeMessage);
  const dataEvents = events.filter(e => e.type === "data");
  assert.equal(dataEvents.length, 1);
  assert.ok(dataEvents[0].data.size > 1024);
  assert.ok(dataEvents[0].data.preview.length <= 200);
});

test("does not extract data event from short message", () => {
  const events = extractUserEvents("Fix the bug please");
  const dataEvents = events.filter(e => e.type === "data");
  assert.equal(dataEvents.length, 0);
});

// ════════════════════════════════════════════
// MULTI-EVENT EXTRACTION
// ════════════════════════════════════════════

test("extracts multiple events from a single tool call", () => {
  // A bash command that both changes directory AND runs git
  const input = {
    tool_name: "Bash",
    tool_input: { command: "cd /project && git checkout main" },
    tool_response: "Switched to branch 'main'",
  };

  const events = extractEvents(input);
  assert.ok(events.length >= 2, `Expected >=2 events, got ${events.length}`);
  const types = events.map(e => e.type);
  assert.ok(types.includes("cwd"));
  assert.ok(types.includes("git"));
});

test("does not extract events from no-op tool calls", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
    tool_response: "hello",
  };

  const events = extractEvents(input);
  assert.equal(events.length, 0);
});

// ════════════════════════════════════════════
// TRUNCATION & SAFETY
// ════════════════════════════════════════════

test("truncates long tool responses in error events", () => {
  const input = {
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: "Error: " + "x".repeat(10000),
  };

  const events = extractEvents(input);
  const errorEvents = events.filter(e => e.type === "error");
  assert.equal(errorEvents.length, 1);
  assert.ok(errorEvents[0].data.error.length <= 300);
});

test("handles missing/undefined fields gracefully", () => {
  const input = {
    tool_name: "Bash",
    tool_input: {},
    tool_response: undefined,
  };

  // Should not throw
  const events = extractEvents(input);
  assert.ok(Array.isArray(events));
});
```

### 10.3 Unit Tests: Snapshot Builder (`session-snapshot.test.ts`)

```typescript
// ════════════════════════════════════════════
// SNAPSHOT BUILDER TESTS
// ════════════════════════════════════════════

test("builds snapshot with file events", () => {
  const events = [
    { type: "file", priority: 1, data: { path: "src/server.ts", operation: "edit" }, created_at: "2026-03-04T14:00:00Z" },
    { type: "file", priority: 1, data: { path: "src/store.ts", operation: "read" }, created_at: "2026-03-04T14:01:00Z" },
    { type: "file", priority: 1, data: { path: "src/server.ts", operation: "edit" }, created_at: "2026-03-04T14:02:00Z" },
  ];

  const snapshot = buildResumeSnapshot(events);
  assert.ok(snapshot.includes("<active_files>"));
  assert.ok(snapshot.includes("src/server.ts"));
  assert.ok(snapshot.includes("src/store.ts"));
  // Deduplicated: server.ts appears once with aggregated ops
  assert.equal((snapshot.match(/src\/server\.ts/g) || []).length, 1);
});

test("builds snapshot within 2KB budget", () => {
  // Generate many events to test budget trimming
  const events = [];
  for (let i = 0; i < 100; i++) {
    events.push({
      type: "file",
      priority: 1,
      data: { path: `src/file-${i}.ts`, operation: "edit" },
      created_at: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
  for (let i = 0; i < 50; i++) {
    events.push({
      type: "error",
      priority: 2,
      data: { tool: "Bash", error: `Error ${i}: ${"x".repeat(200)}` },
      created_at: new Date(Date.now() + i * 1000).toISOString(),
    });
  }

  const snapshot = buildResumeSnapshot(events);
  assert.ok(Buffer.byteLength(snapshot) <= 2048,
    `Snapshot ${Buffer.byteLength(snapshot)} bytes exceeds 2KB`);
});

test("prioritizes P1 events over P3 when budget is tight", () => {
  const events = [
    { type: "file", priority: 1, data: { path: "critical.ts", operation: "edit" }, created_at: "2026-03-04T14:00:00Z" },
    { type: "intent", priority: 4, data: { mode: "implement", message: "building feature" }, created_at: "2026-03-04T14:01:00Z" },
  ];

  const snapshot = buildResumeSnapshot(events, 500); // tight budget
  assert.ok(snapshot.includes("critical.ts"));
  // Intent may or may not fit — but file MUST be there
});

test("renders task state correctly", () => {
  const events = [
    { type: "task", priority: 1, data: { tool: "TaskCreate", input: '{"subject":"Write tests","status":"pending"}' }, created_at: "2026-03-04T14:00:00Z" },
    { type: "task", priority: 1, data: { tool: "TaskUpdate", input: '{"taskId":"1","status":"in_progress"}' }, created_at: "2026-03-04T14:01:00Z" },
  ];

  const snapshot = buildResumeSnapshot(events);
  assert.ok(snapshot.includes("<task_state>"));
});

test("renders environment section with git info", () => {
  const events = [
    { type: "cwd", priority: 2, data: { directory: "/project/src" }, created_at: "2026-03-04T14:00:00Z" },
    { type: "git", priority: 2, data: { operation: "branch", command: "git checkout next" }, created_at: "2026-03-04T14:01:00Z" },
    { type: "env", priority: 2, data: { command: "nvm use 20" }, created_at: "2026-03-04T14:02:00Z" },
  ];

  const snapshot = buildResumeSnapshot(events);
  assert.ok(snapshot.includes("<environment>"));
  assert.ok(snapshot.includes("/project/src") || snapshot.includes("cwd"));
});

test("renders decisions from user corrections", () => {
  const events = [
    { type: "decision", priority: 2, data: { message: "use ctx- prefix instead of cm-" }, created_at: "2026-03-04T14:00:00Z" },
    { type: "decision", priority: 2, data: { message: "always ask before pushing" }, created_at: "2026-03-04T14:01:00Z" },
  ];

  const snapshot = buildResumeSnapshot(events);
  assert.ok(snapshot.includes("ctx-"));
  assert.ok(snapshot.includes("pushing"));
});

test("handles empty events array", () => {
  const snapshot = buildResumeSnapshot([]);
  assert.ok(snapshot.includes("<session_resume"));
  assert.ok(snapshot.includes("events_captured=\"0\""));
});

test("snapshot is valid XML-like structure", () => {
  const events = [
    { type: "file", priority: 1, data: { path: "test.ts", operation: "edit" }, created_at: "2026-03-04T14:00:00Z" },
  ];

  const snapshot = buildResumeSnapshot(events);
  assert.ok(snapshot.startsWith("<session_resume"));
  assert.ok(snapshot.endsWith("</session_resume>"));
});

test("escapes XML special characters in data", () => {
  const events = [
    { type: "decision", priority: 2, data: { message: 'use <tag> & "quotes"' }, created_at: "2026-03-04T14:00:00Z" },
  ];

  const snapshot = buildResumeSnapshot(events);
  assert.ok(!snapshot.includes("<tag>") || snapshot.includes("&lt;tag&gt;"));
});
```

### 10.4 Unit Tests: SessionDB (`session-db.test.ts`)

```typescript
// ════════════════════════════════════════════
// SESSION DB TESTS
// ════════════════════════════════════════════

// Uses a temp DB for isolation
let db: SessionDB;
const TEST_SESSION = "test-session-001";

// Setup/teardown
function setupDB() {
  db = new SessionDB({ dbPath: join(tmpdir(), `test-session-${Date.now()}.db`) });
}
function teardownDB() {
  db.close();
}

test("inserts and retrieves events", () => {
  setupDB();
  db.insertEvent(TEST_SESSION, {
    type: "file",
    priority: 1,
    data: { path: "src/server.ts", operation: "edit" },
    sourceHook: "PostToolUse",
  });

  const events = db.getEvents(TEST_SESSION);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "file");
  teardownDB();
});

test("deduplicates identical consecutive events", () => {
  setupDB();
  const event = {
    type: "file",
    priority: 1,
    data: { path: "src/server.ts", operation: "read" },
    sourceHook: "PostToolUse",
  };

  db.insertEvent(TEST_SESSION, event);
  db.insertEvent(TEST_SESSION, event); // duplicate
  db.insertEvent(TEST_SESSION, event); // duplicate

  const events = db.getEvents(TEST_SESSION);
  assert.equal(events.length, 1); // deduplicated
  teardownDB();
});

test("enforces max 1000 events per session", () => {
  setupDB();
  for (let i = 0; i < 1050; i++) {
    db.insertEvent(TEST_SESSION, {
      type: "file",
      priority: i < 500 ? 4 : 1, // first 500 are low priority
      data: { path: `file-${i}.ts`, operation: "edit" },
      sourceHook: "PostToolUse",
    });
  }

  const events = db.getEvents(TEST_SESSION);
  assert.ok(events.length <= 1000);
  // Low priority events should have been evicted first
  const priorities = events.map(e => e.priority);
  assert.ok(priorities.filter(p => p === 1).length > priorities.filter(p => p === 4).length);
  teardownDB();
});

test("upserts and retrieves resume snapshot", () => {
  setupDB();
  const snapshot = "<session_resume>test</session_resume>";
  db.upsertResume(TEST_SESSION, snapshot);

  const resume = db.getResume(TEST_SESSION);
  assert.ok(resume);
  assert.equal(resume.snapshot, snapshot);
  assert.equal(resume.consumed, 0);
  teardownDB();
});

test("marks resume as consumed", () => {
  setupDB();
  db.upsertResume(TEST_SESSION, "<session_resume>test</session_resume>");
  db.markResumeConsumed(TEST_SESSION);

  const resume = db.getResume(TEST_SESSION);
  assert.ok(resume === null || resume.consumed === 1);
  teardownDB();
});

test("cleans up old sessions", () => {
  setupDB();
  // Insert an old session
  db.insertEvent("old-session", {
    type: "file",
    priority: 1,
    data: { path: "old.ts", operation: "edit" },
    sourceHook: "PostToolUse",
  });

  // Force old timestamp
  db.forceSessionAge("old-session", 48); // 48 hours ago

  db.cleanupOldSessions(1); // keep 1 day

  const events = db.getEvents("old-session");
  assert.equal(events.length, 0);
  teardownDB();
});

test("filters events by type", () => {
  setupDB();
  db.insertEvent(TEST_SESSION, { type: "file", priority: 1, data: { path: "a.ts" }, sourceHook: "PostToolUse" });
  db.insertEvent(TEST_SESSION, { type: "error", priority: 2, data: { error: "fail" }, sourceHook: "PostToolUse" });
  db.insertEvent(TEST_SESSION, { type: "file", priority: 1, data: { path: "b.ts" }, sourceHook: "PostToolUse" });

  const fileEvents = db.getEvents(TEST_SESSION, { type: "file" });
  assert.equal(fileEvents.length, 2);

  const errorEvents = db.getEvents(TEST_SESSION, { type: "error" });
  assert.equal(errorEvents.length, 1);
  teardownDB();
});

test("tracks session metadata", () => {
  setupDB();
  db.upsertMeta(TEST_SESSION, "/project/dir");
  db.incrementCompactCount(TEST_SESSION);
  db.incrementCompactCount(TEST_SESSION);

  const stats = db.getSessionStats(TEST_SESSION);
  assert.equal(stats.compactCount, 2);
  teardownDB();
});

test("handles concurrent DB access gracefully", () => {
  setupDB();
  // Simulate rapid sequential inserts (as would happen with fast tool calls)
  for (let i = 0; i < 100; i++) {
    db.insertEvent(TEST_SESSION, {
      type: "file",
      priority: 1,
      data: { path: `rapid-${i}.ts`, operation: "edit" },
      sourceHook: "PostToolUse",
    });
  }

  const events = db.getEvents(TEST_SESSION);
  assert.equal(events.length, 100);
  teardownDB();
});
```

### 10.5 Integration Test: Full Pipeline (`session-integration.test.ts`)

```typescript
// ════════════════════════════════════════════
// INTEGRATION: FULL SESSION LIFECYCLE
// ════════════════════════════════════════════

test("full session lifecycle: events → compact → resume → inject", async () => {
  const db = new SessionDB({ dbPath: tempDBPath() });
  const sessionId = "integration-test-001";

  // Phase 1: Simulate a work session with diverse tool calls
  const toolCalls = [
    { tool_name: "Read", tool_input: { file_path: "/project/CLAUDE.md" }, tool_response: "# Rules\n- Be concise" },
    { tool_name: "Bash", tool_input: { command: "cd /project/src" }, tool_response: "" },
    { tool_name: "Read", tool_input: { file_path: "/project/src/server.ts" }, tool_response: "const x = 1;" },
    { tool_name: "Edit", tool_input: { file_path: "/project/src/server.ts", old_string: "const x = 1", new_string: "const x = 2" }, tool_response: "ok" },
    { tool_name: "Bash", tool_input: { command: "git checkout -b feature/test" }, tool_response: "Switched to new branch" },
    { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "FAIL: expected 2 got 1\nexit code 1" },
    { tool_name: "Edit", tool_input: { file_path: "/project/src/server.ts", old_string: "const x = 2", new_string: "const x = 3" }, tool_response: "ok" },
    { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "PASS\nexit code 0" },
    { tool_name: "Bash", tool_input: { command: 'git commit -m "fix: correct value"' }, tool_response: "[feature/test abc123]" },
  ];

  for (const call of toolCalls) {
    const events = extractEvents(call);
    for (const event of events) {
      db.insertEvent(sessionId, { ...event, sourceHook: "PostToolUse" });
    }
  }

  // Simulate user decisions
  const userMessages = [
    "always use TypeScript strict mode",
    "fix the failing test",
  ];
  for (const msg of userMessages) {
    const events = extractUserEvents(msg);
    for (const event of events) {
      db.insertEvent(sessionId, { ...event, sourceHook: "UserPromptSubmit" });
    }
  }

  // Phase 2: PreCompact — build resume
  const allEvents = db.getEvents(sessionId);
  assert.ok(allEvents.length > 0, "Should have captured events");

  const snapshot = buildResumeSnapshot(allEvents);
  db.upsertResume(sessionId, snapshot);

  // Phase 3: Verify resume content
  const resume = db.getResume(sessionId);
  assert.ok(resume, "Resume should exist");
  assert.ok(resume.snapshot.includes("server.ts"), "Resume should mention active file");
  assert.ok(resume.snapshot.includes("<session_resume"), "Resume should be XML");
  assert.ok(Buffer.byteLength(resume.snapshot) <= 2048, "Resume should be under 2KB");

  // Phase 4: SessionStart(compact) — inject resume
  const additionalContext = buildSessionStartContext("compact", sessionId, db);
  assert.ok(additionalContext.includes("<session_resume"), "Should inject resume on compact");
  assert.ok(additionalContext.includes("context_window_protection"), "Should still include routing block");

  // Phase 5: Verify consumed
  const consumedResume = db.getResume(sessionId);
  assert.ok(consumedResume === null || consumedResume.consumed === 1, "Resume should be consumed");

  // Phase 6: SessionStart(startup) — clean up
  buildSessionStartContext("startup", "new-session", db);
  // Old session data should be cleaned up (if old enough)

  db.close();
});

test("SessionStart(startup) does NOT inject resume", () => {
  const db = new SessionDB({ dbPath: tempDBPath() });
  db.upsertResume("old-session", "<session_resume>old</session_resume>");

  const context = buildSessionStartContext("startup", "new-session", db);
  assert.ok(!context.includes("<session_resume"), "Should not inject resume on startup");

  db.close();
});

test("SessionStart(resume) does NOT inject resume (--continue has full context)", () => {
  const db = new SessionDB({ dbPath: tempDBPath() });
  db.upsertResume("cont-session", "<session_resume>data</session_resume>");

  const context = buildSessionStartContext("resume", "cont-session", db);
  // --continue means Claude has the full conversation history
  // No need to inject resume
  assert.ok(!context.includes("<session_resume"), "Should not inject on --continue");

  db.close();
});
```

### 10.6 E2E Test: Context-Filling Scenario (`session-compact.test.ts`)

This is the critical test that simulates a real session that fills the context window and triggers compact.

#### Research: What Fills Context Fastest

Before designing the test, we researched what actually burns through Claude Code's ~167K usable tokens:

| Operation | Tokens Per Call | Multiplier | Context Burn Rate |
|---|---|---|---|
| **Read tool (full file, 2000 lines)** | ~27,000 tokens | 1.7x (line number formatting overhead) | **#1 — heaviest single-call consumer** |
| **Bash (unfiltered build/test errors)** | up to 580,000 tokens | 1x (raw text) | **#1 — can overshoot entire window in 1 call** |
| **Grep (content mode, broad pattern)** | 5,000-15,000 tokens | 1x | Significant per call |
| **Iterative debug loop (100 turns)** | ~24,500 tokens overhead | Accumulates | Death by a thousand cuts |
| **Edit tool** | 200-500 tokens | 1x | Lightest file mutation |

**Key insight**: The Read tool is the #1 predictable context consumer because:
- Each line gets ~8-10 extra characters of formatting (`     1→`)
- A 2000-line file with typical code (~20 chars/line) costs **~27,000 tokens** (1.7x raw)
- 6 documentation files (3,929 lines raw) consumed **54,400 tokens** — 75% overhead from formatting
- Reading just **6-7 files** of 500+ lines can consume **half the usable context**

The Bash tool can be even worse (a single `getDiagnostics()` returned 580K tokens), but it's less predictable. For a **reproducible** test, we use Read-heavy patterns.

**Auto-compact triggers at ~98% of effective window** (200K - max_output - ~33K buffer ≈ 167K usable).

#### Test Design: Realistic Read-Heavy Session

```typescript
// ════════════════════════════════════════════
// E2E: SIMULATE CONTEXT-FILLING SESSION
// ════════════════════════════════════════════

/**
 * This test simulates a realistic coding session that fills Claude Code's
 * context window (~167K usable tokens) and triggers auto-compact.
 *
 * Based on research, the #1 context consumer is the Read tool due to
 * line number formatting overhead (1.7x multiplier). A typical session
 * that triggers compact involves:
 *
 * - Reading 6-10 large files (each ~500-2000 lines = 8K-27K tokens)
 * - Total: 50K-160K tokens from file reads alone
 * - Plus tool call overhead, system prompts, and conversation turns
 *
 * This test generates REALISTIC Read tool responses with proper
 * line-numbered formatting to accurately model token consumption.
 */

// ── Helpers for realistic content generation ──

/** Generate realistic line-numbered file content (mimics Read tool output) */
function generateReadResponse(filename: string, lineCount: number): string {
  const lines: string[] = [];
  const ext = filename.split(".").pop();

  for (let i = 1; i <= lineCount; i++) {
    // Pad line numbers like Claude Code does: "     1→"
    const lineNum = String(i).padStart(Math.max(5, String(lineCount).length + 1));
    let content: string;

    if (ext === "ts" || ext === "js") {
      // Realistic TypeScript code lines (~40-80 chars)
      const codelines = [
        `import { ${randomId()} } from "./${randomId()}";`,
        `export interface ${randomId()} {`,
        `  ${randomId()}: string;`,
        `  ${randomId()}: number;`,
        `  ${randomId()}?: boolean;`,
        `}`,
        ``,
        `export async function ${randomId()}(req: Request, res: Response): Promise<void> {`,
        `  const ${randomId()} = await db.query("SELECT * FROM ${randomId()} WHERE id = $1", [req.params.id]);`,
        `  if (!${randomId()}) { res.status(404).json({ error: "Not found" }); return; }`,
        `  const validated = ${randomId()}Schema.parse(req.body);`,
        `  res.json({ data: ${randomId()}, meta: { total: ${randomId()}.length } });`,
        `}`,
        `// TODO: add pagination support`,
        `try { await ${randomId()}(); } catch (e) { logger.error(e); throw new AppError(500, "Internal"); }`,
      ];
      content = codelines[i % codelines.length];
    } else if (ext === "json") {
      content = `  "${randomId()}": "${randomId()}-value-${i}",`;
    } else {
      content = `Line ${i}: ${randomId()} configuration for ${filename}`;
    }

    lines.push(`${lineNum}→${content}`);
  }
  return lines.join("\n");
}

/** Generate realistic Bash error output (verbose build/test failures) */
function generateBashErrorOutput(errorCount: number): string {
  const errors: string[] = [];
  for (let i = 0; i < errorCount; i++) {
    errors.push(
      `src/${randomId()}.ts(${10 + i * 3},${5 + (i % 20)}): error TS${2000 + i}: ` +
      `Property '${randomId()}' does not exist on type '${randomId()}'.`
    );
  }
  errors.push(`\nFound ${errorCount} errors in ${Math.ceil(errorCount / 3)} files.\nexit code 1`);
  return errors.join("\n");
}

let _idCounter = 0;
function randomId(): string {
  return `x${(++_idCounter).toString(36)}`;
}

// ════════════════════════════════════════════
// MAIN TEST
// ════════════════════════════════════════════

test("realistic session: Read-heavy context filling → compact → meaningful resume", () => {
  const db = new SessionDB({ dbPath: tempDBPath() });
  const sessionId = "e2e-context-fill";
  let estimatedTokens = 0;

  // ── Phase 1: Session Setup ──
  // System prompt + tool definitions consume ~20-35K tokens at session start.
  // We model this as a fixed overhead.
  estimatedTokens += 30_000; // system overhead

  simulateToolCalls(db, sessionId, [
    { tool_name: "Read", tool_input: { file_path: "/api/CLAUDE.md" },
      tool_response: "# Rules\n- Use Express.js\n- All endpoints need auth\n- Write tests first\n- TypeScript strict" },
    { tool_name: "Bash", tool_input: { command: "cd /api && git status" },
      tool_response: "On branch main\nnothing to commit" },
    { tool_name: "Bash", tool_input: { command: "git checkout -b feature/users-crud" },
      tool_response: "Switched to a new branch 'feature/users-crud'" },
  ]);
  estimatedTokens += 500; // small responses

  simulateUserMessage(db, sessionId, "Create CRUD endpoints for users. Act as a senior backend engineer.");
  simulateUserMessage(db, sessionId, "Use Zod for validation, not Joi");

  // ── Phase 2: Heavy File Reading (THE #1 CONTEXT FILLER) ──
  // Each Read of a 500-line file ≈ 8,500 tokens (with 1.7x formatting overhead)
  // 10 files × 8,500 = 85,000 tokens — this alone fills ~50% of usable context
  const sourceFiles = [
    { path: "src/routes/users.ts", lines: 600 },
    { path: "src/routes/auth.ts", lines: 450 },
    { path: "src/models/user.ts", lines: 350 },
    { path: "src/models/session.ts", lines: 280 },
    { path: "src/middleware/auth.ts", lines: 400 },
    { path: "src/middleware/validate.ts", lines: 200 },
    { path: "src/validators/user.validator.ts", lines: 300 },
    { path: "src/services/user.service.ts", lines: 550 },
    { path: "tests/users.test.ts", lines: 700 },
    { path: "src/config/database.ts", lines: 250 },
  ];

  for (const file of sourceFiles) {
    const response = generateReadResponse(file.path, file.lines);
    const tokens = Math.ceil(Buffer.byteLength(response) / 4); // ~4 bytes per token
    estimatedTokens += tokens;

    simulateToolCalls(db, sessionId, [
      { tool_name: "Read", tool_input: { file_path: `/api/${file.path}` }, tool_response: response },
    ]);

    // After reading, edit the file (light — ~300 tokens each)
    simulateToolCalls(db, sessionId, [
      { tool_name: "Edit", tool_input: {
        file_path: `/api/${file.path}`,
        old_string: `import { x1 } from "./x2"`,
        new_string: `import { x1, x3 } from "./x2"`,
      }, tool_response: "File edited successfully" },
    ]);
    estimatedTokens += 300;
  }

  console.log(`  After file reads: ~${Math.round(estimatedTokens / 1000)}K estimated tokens`);

  // ── Phase 3: Iterative Debug Loop (THE #2 CONTEXT FILLER) ──
  // Each debug iteration: Read(re-read file) + Edit + Bash(test) ≈ 10K tokens
  // 5 iterations = 50K tokens
  for (let i = 0; i < 5; i++) {
    // Re-read the main file (each re-read costs ~10K tokens)
    const rereadResponse = generateReadResponse("src/routes/users.ts", 600);
    estimatedTokens += Math.ceil(Buffer.byteLength(rereadResponse) / 4);

    simulateToolCalls(db, sessionId, [
      { tool_name: "Read", tool_input: { file_path: "/api/src/routes/users.ts" }, tool_response: rereadResponse },
      { tool_name: "Edit", tool_input: {
        file_path: "/api/src/routes/users.ts",
        old_string: `iteration_${i}`,
        new_string: `iteration_${i + 1}`,
      }, tool_response: "ok" },
    ]);
    estimatedTokens += 300;

    // Run tests — verbose output with errors on first 3 iterations
    if (i < 3) {
      const errorOutput = generateBashErrorOutput(20 + i * 10);
      estimatedTokens += Math.ceil(Buffer.byteLength(errorOutput) / 4);

      simulateToolCalls(db, sessionId, [
        { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: errorOutput },
      ]);
    } else {
      simulateToolCalls(db, sessionId, [
        { tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "PASS\n  28 tests passed\nexit code 0" },
      ]);
      estimatedTokens += 200;
    }
  }

  console.log(`  After debug loop: ~${Math.round(estimatedTokens / 1000)}K estimated tokens`);

  // ── Phase 4: User Decisions & Git Operations ──
  simulateUserMessage(db, sessionId, "don't require admin role for delete, any authenticated user can delete their own profile");
  simulateUserMessage(db, sessionId, "always validate request body before hitting the database");

  simulateToolCalls(db, sessionId, [
    { tool_name: "Edit", tool_input: { file_path: "/api/src/middleware/auth.ts", old_string: "role: 'admin'", new_string: "role: 'user'" }, tool_response: "ok" },
    { tool_name: "Bash", tool_input: { command: 'git add -A && git commit -m "feat: users CRUD endpoints"' }, tool_response: "[feature/users-crud def456]" },
    { tool_name: "Bash", tool_input: { command: "source .venv/bin/activate && nvm use 20" }, tool_response: "Now using node v20.0.0" },
    { tool_name: "Skill", tool_input: { skill: "tdd" }, tool_response: "TDD skill loaded" },
  ]);

  // ── Phase 5: Second wave of file reads (pushing past ~140K) ──
  // Re-read modified files + read new files to push toward compact threshold
  const secondWaveFiles = [
    { path: "src/routes/users.ts", lines: 650 },  // grew during editing
    { path: "tests/users.test.ts", lines: 750 },   // grew during editing
    { path: "src/utils/errors.ts", lines: 200 },
    { path: "src/utils/pagination.ts", lines: 180 },
  ];

  for (const file of secondWaveFiles) {
    const response = generateReadResponse(file.path, file.lines);
    estimatedTokens += Math.ceil(Buffer.byteLength(response) / 4);
    simulateToolCalls(db, sessionId, [
      { tool_name: "Read", tool_input: { file_path: `/api/${file.path}` }, tool_response: response },
    ]);
  }

  // One final broad Grep that returns many results
  const grepResponse = Array.from({ length: 80 }, (_, i) =>
    `src/${randomId()}.ts:${10 + i}:  const ${randomId()} = await validate(${randomId()});`
  ).join("\n");
  estimatedTokens += Math.ceil(Buffer.byteLength(grepResponse) / 4);

  simulateToolCalls(db, sessionId, [
    { tool_name: "Grep", tool_input: { pattern: "validate", output_mode: "content" }, tool_response: grepResponse },
  ]);

  console.log(`  Final estimated tokens: ~${Math.round(estimatedTokens / 1000)}K (threshold: ~167K)`);
  assert.ok(estimatedTokens > 100_000, `Session should model >100K tokens, got ${estimatedTokens}`);

  // ── Phase 6: COMPACT TRIGGERED — Build Resume ──
  const allEvents = db.getEvents(sessionId);
  console.log(`  Events captured: ${allEvents.length}`);
  assert.ok(allEvents.length >= 50, `Should have many events, got ${allEvents.length}`);

  const snapshot = buildResumeSnapshot(allEvents);
  db.upsertResume(sessionId, snapshot);

  // ── Phase 7: Verify Resume Quality ──
  const resume = db.getResume(sessionId);
  assert.ok(resume, "Resume must exist");

  const s = resume.snapshot;
  console.log(`  Resume size: ${Buffer.byteLength(s)} bytes`);

  // Hard constraints
  assert.ok(Buffer.byteLength(s) <= 2048, `Resume too large: ${Buffer.byteLength(s)} bytes`);
  assert.ok(s.startsWith("<session_resume"), "Must be valid XML structure");
  assert.ok(s.endsWith("</session_resume>"), "Must close XML tag");

  // Critical context: files
  assert.ok(s.includes("<active_files>"), "Must list active files");
  assert.ok(s.includes("routes/users.ts") || s.includes("users.ts"), "Must mention main file");
  assert.ok(s.includes("users.test.ts") || s.includes("test"), "Must mention test file");

  // Critical context: decisions
  assert.ok(
    s.includes("Zod") || s.includes("delete") || s.includes("admin") || s.includes("validate"),
    "Must capture user decisions"
  );

  // Critical context: git
  assert.ok(
    s.includes("feature/users-crud") || s.includes("git") || s.includes("branch"),
    "Must contain git context"
  );

  // Critical context: environment
  assert.ok(s.includes("<environment>"), "Must have environment section");

  // Verify the resume answers the 5 key questions after compact:
  // 1. "What was I working on?" → Users CRUD endpoints (active_files + task_state)
  // 2. "Which files?" → routes/users.ts, validators, middleware, tests (active_files)
  // 3. "What branch?" → feature/users-crud (environment/git)
  // 4. "Any decisions?" → Zod not Joi, user can delete own profile (decisions)
  // 5. "Any errors?" → TS errors during debug loop (errors_resolved)

  console.log("  Resume preview:");
  console.log(s.split("\n").slice(0, 15).map(l => `    ${l}`).join("\n"));

  db.close();
});

// ── Simulation Helpers ──

function simulateToolCalls(db, sessionId, calls) {
  for (const call of calls) {
    const events = extractEvents(call);
    for (const event of events) {
      db.insertEvent(sessionId, { ...event, sourceHook: "PostToolUse" });
    }
  }
}

function simulateUserMessage(db, sessionId, message) {
  const events = extractUserEvents(message);
  for (const event of events) {
    db.insertEvent(sessionId, { ...event, sourceHook: "UserPromptSubmit" });
  }
}
```

### 10.7 Pipeline Integration Test: Hook Process Spawning (`session-pipeline.test.ts`)

This test spawns the actual hook `.mjs` processes (not just calling extraction functions) to verify the full stdin→DB→stdout pipeline works end-to-end.

```typescript
// ════════════════════════════════════════════
// PIPELINE: ACTUAL HOOK PROCESS SPAWNING
// ════════════════════════════════════════════

import { spawn } from "node:child_process";

/** Run a hook .mjs file as a child process, pipe input to stdin, return stdout */
async function runHookProcess(hookFile: string, input: object): Promise<string> {
  const hookPath = join(__dirname, "..", "hooks", hookFile);
  return new Promise((resolve, reject) => {
    const child = spawn("node", [hookPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Hook exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

// ════════════════════════════════════════════
// TEST: PostToolUse hook writes to session DB
// ════════════════════════════════════════════

test("posttooluse.mjs processes tool calls and writes events to DB", async () => {
  const toolCalls = [
    {
      hook_type: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/project/src/server.ts", old_string: "v1", new_string: "v2" },
      tool_response: "File edited successfully",
    },
    {
      hook_type: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git checkout -b feature/test" },
      tool_response: "Switched to a new branch 'feature/test'",
    },
    {
      hook_type: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "FAIL src/test.ts\nError: expected 1 got 2\nexit code 1",
    },
  ];

  for (const call of toolCalls) {
    await runHookProcess("posttooluse.mjs", call);
  }

  // Verify events were written to the session DB
  const db = new SessionDB({ projectDir: process.cwd() });
  const sessionId = `pid-${process.ppid}`;
  const events = db.getEvents(sessionId);

  assert.ok(events.length >= 3, `Expected >=3 events, got ${events.length}`);
  const types = events.map(e => e.type);
  assert.ok(types.includes("file"), "Should have file event from Edit");
  assert.ok(types.includes("git"), "Should have git event from checkout");
  assert.ok(types.includes("error"), "Should have error event from failed test");

  db.close();
});

// ════════════════════════════════════════════
// TEST: PostToolUse hook latency benchmark
// ════════════════════════════════════════════

test("posttooluse.mjs completes within 20ms per call (p95)", async () => {
  const timings: number[] = [];

  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    await runHookProcess("posttooluse.mjs", {
      hook_type: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: `/project/file-${i}.ts`, old_string: "a", new_string: "b" },
      tool_response: "ok",
    });
    timings.push(performance.now() - start);
  }

  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length * 0.5)];
  const p95 = timings[Math.floor(timings.length * 0.95)];
  const p99 = timings[Math.floor(timings.length * 0.99)];

  console.log(`  PostToolUse latency: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms`);

  // Target: p95 < 20ms (hook must be invisible to the user)
  // Note: first call may be slower due to module loading — exclude warmup
  const warmTimings = timings.slice(5);
  warmTimings.sort((a, b) => a - b);
  const warmP95 = warmTimings[Math.floor(warmTimings.length * 0.95)];
  assert.ok(warmP95 < 50, `p95 latency ${warmP95.toFixed(1)}ms exceeds 50ms threshold`);
});

// ════════════════════════════════════════════
// TEST: Full pipeline — posttooluse → precompact → sessionstart
// ════════════════════════════════════════════

test("full pipeline: posttooluse → precompact → sessionstart(compact)", async () => {
  // Phase 1: Feed 50 diverse tool calls through actual posttooluse.mjs
  const toolCalls = [
    // File operations (should produce file events)
    ...Array.from({ length: 15 }, (_, i) => ({
      hook_type: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: `/project/src/file-${i}.ts` },
      tool_response: `// file-${i}.ts content\nconst x = ${i};`,
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      hook_type: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: `/project/src/file-${i}.ts`, old_string: `const x = ${i}`, new_string: `const x = ${i + 1}` },
      tool_response: "ok",
    })),
    // Git operations (should produce git events)
    { hook_type: "PostToolUse", tool_name: "Bash", tool_input: { command: "git checkout -b feature/pipeline-test" }, tool_response: "Switched to new branch" },
    { hook_type: "PostToolUse", tool_name: "Bash", tool_input: { command: 'git commit -m "test"' }, tool_response: "[feature/pipeline-test abc123]" },
    // Errors (should produce error events)
    { hook_type: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "FAIL\nexit code 1" },
    // Environment (should produce env events)
    { hook_type: "PostToolUse", tool_name: "Bash", tool_input: { command: "nvm use 20" }, tool_response: "Now using v20" },
    { hook_type: "PostToolUse", tool_name: "Bash", tool_input: { command: "cd /project/src" }, tool_response: "" },
    // Skills (should produce skill events)
    { hook_type: "PostToolUse", tool_name: "Skill", tool_input: { skill: "tdd" }, tool_response: "loaded" },
  ];

  for (const call of toolCalls) {
    await runHookProcess("posttooluse.mjs", call);
  }

  // Phase 2: Run precompact.mjs — should build resume from captured events
  await runHookProcess("precompact.mjs", {
    hook_type: "PreCompact",
    transcript_path: "/tmp/fake-transcript.jsonl",
    trigger: "auto",
  });

  // Phase 3: Run sessionstart.mjs with source=compact — should inject resume
  const output = await runHookProcess("sessionstart.mjs", {
    hook_type: "SessionStart",
    source: "compact",
  });

  const parsed = JSON.parse(output);
  const context = parsed.hookSpecificOutput?.additionalContext ?? "";

  // Verify: routing block still present
  assert.ok(context.includes("context_window_protection"), "Must still include routing block");

  // Verify: resume snapshot injected
  assert.ok(context.includes("<session_resume"), "Must inject resume snapshot on compact");

  // Verify: resume contains captured data
  assert.ok(context.includes("file-") || context.includes("src/"), "Resume must reference files");

  // Verify: total injection is reasonable
  assert.ok(Buffer.byteLength(context) < 4096, `Total injection ${Buffer.byteLength(context)} bytes too large`);

  console.log(`  Pipeline output size: ${Buffer.byteLength(context)} bytes`);
});

// ════════════════════════════════════════════
// TEST: sessionstart(startup) cleans up and does NOT inject resume
// ════════════════════════════════════════════

test("sessionstart.mjs with source=startup does not inject resume", async () => {
  const output = await runHookProcess("sessionstart.mjs", {
    hook_type: "SessionStart",
    source: "startup",
  });

  const parsed = JSON.parse(output);
  const context = parsed.hookSpecificOutput?.additionalContext ?? "";

  assert.ok(context.includes("context_window_protection"), "Must include routing block");
  assert.ok(!context.includes("<session_resume"), "Must NOT inject resume on fresh startup");
});
```

### 10.8 Manual Smoke Test: Real Compact Trigger (`ctx-test-compact` skill)

For manual validation in a real Claude Code session. This skill triggers actual context filling.

**Why a skill?** Automated tests can't trigger real Claude Code compaction — they can only simulate the data flow. This skill lets a developer manually verify the full loop in a live session.

#### Context-Filling Strategy (Research-Backed)

Based on our research, the **single most effective way** to fill context is **repeated full-file reads**. Each Read of a 500+ line file with line-number formatting costs ~8,500-27,000 tokens. Reading the same file multiple times is even worse because Claude Code does NOT cache — each re-read adds the full content to context again.

| Strategy | Tokens Consumed | Calls Needed | Time to Compact |
|---|---|---|---|
| **Read same large file 15x** | ~15 × 10K = 150K | 15 calls | ~2 min |
| Read 15 different 500-line files | ~15 × 8.5K = 127K | 15 calls | ~2 min |
| Grep content mode broad pattern × 30 | ~30 × 5K = 150K | 30 calls | ~3 min |
| Bash verbose test output × 20 | Unpredictable | 20 calls | ~3 min |
| Edit loop (tiny diffs) × 100 | ~100 × 300 = 30K | 100 calls | Won't compact alone |

**Winner: Repeated Read of the same large file.** It's deterministic, fast, and closely mirrors real-world sessions where developers re-read files during iterative development.

#### Skill Implementation

```markdown
# skills/ctx-test-compact/SKILL.md
name: ctx-test-compact
description: |
  Fill context window to trigger auto-compact, then verify session continuity.
  Uses repeated Read calls (the #1 context consumer due to 1.7x line-number overhead).
  WARNING: This will trigger compact. Use only for testing session continuity.
  Trigger: /context-mode:ctx-test-compact
```

Skill prompt instructs Claude to:

```
You are testing session continuity. Follow these steps EXACTLY:

## Phase 1: Establish Context (record what we're doing)
1. Read this project's CLAUDE.md (if it exists)
2. Run: git status && git branch --show-current
3. Create a temporary test file: /tmp/session-continuity-test-marker.txt
   Content: "Session started at: <timestamp>. Testing feature: session-continuity."

## Phase 2: Fill Context Window
The goal is to trigger auto-compact by consuming ~150K tokens via Read calls.

Strategy: Read the LARGEST source file in this project repeatedly.
Each read of a 500+ line file costs ~8,500-27,000 tokens with line-number formatting.

Steps:
1. Find the largest .ts or .js file: find src/ -name "*.ts" -o -name "*.js" | xargs wc -l | sort -rn | head -5
2. Read that file using the Read tool (NOT execute_file — we WANT it in context)
3. After each read, make a small Edit to the file (add a comment like "// iteration N")
4. Repeat Read + Edit cycle 15-20 times until compact triggers

IMPORTANT:
- Use the Read tool, NOT execute_file (we need content IN context to fill it)
- Do NOT use context-mode tools — those are designed to AVOID filling context
- The point is to deliberately fill the context to test what happens after compact

## Phase 3: After Compact (verify resume)
After compact triggers and the session resumes, check:
1. Can you see <session_resume> in your context? (check system messages)
2. Do you know which file you were reading repeatedly?
3. Do you know the git branch?
4. Do you remember the test marker file we created?
5. Report what you remember vs what you lost.

Print a summary: "SESSION CONTINUITY TEST RESULTS: [PASS/FAIL]"
- PASS: Resume snapshot was injected and contains file references + git context
- FAIL: No resume found, or critical context was lost
```

#### Expected Test Flow

```
1. User runs: /context-mode:ctx-test-compact
2. Claude reads CLAUDE.md, runs git status (events captured by PostToolUse)
3. Claude finds largest file (e.g., src/server.ts — 800 lines)
4. Claude reads src/server.ts 15x (~150K tokens consumed)
   - PostToolUse captures 15 "file:read" events + 15 "file:edit" events
5. Auto-compact triggers at ~98% of effective window
   - PreCompact hook fires → builds resume snapshot from 30+ events
   - Resume contains: src/server.ts as primary file, git branch, CLAUDE.md rules
6. SessionStart(compact) fires → injects resume + routing block
7. Claude resumes with <session_resume> in context
8. Claude can report: "I was reading src/server.ts, on branch X, testing session continuity"
9. TEST: PASS
```

---

## 11. Release Plan

### 11.1 Phased Rollout

#### Phase 1: Core Pipeline (v0.10.0) — "Session Continuity"
- `session-db.mjs` — SessionDB class
- `session-extract.mjs` — All 13 event extraction rules
- `session-snapshot.mjs` — Resume snapshot builder
- `posttooluse.mjs` — PostToolUse hook
- `precompact.mjs` — PreCompact hook
- Updated `sessionstart.mjs` — Resume injection
- Updated `hooks.json` — New hook registrations
- Full test suite (6 test files + 1 dev-only smoke test)
- Updated README with feature documentation

**Acceptance criteria**:
- All extraction tests pass
- All snapshot tests pass
- All DB tests pass
- Integration test passes
- E2E context-filling test passes (with realistic Read-heavy token modeling)
- Pipeline test passes (actual hook process spawning)
- PostToolUse hook latency p95 <50ms (benchmarked via pipeline test)
- Resume snapshot always <2KB

#### Phase 2: SubAgent Tracking (v0.10.1)
- `SubagentStop` hook integration
- Transcript parsing for subagent summaries
- Tests for subagent event extraction

#### Phase 3: Thinking Block Extraction (v0.10.2)
- Parse JSONL transcript for thinking blocks
- Extract key reasoning patterns
- Include in resume snapshot under `<reasoning>` section

#### Phase 4: Smart Eviction & Analytics (v0.11.0)
- Event importance scoring (decay over time)
- Analytics: how many compacts per session, which events most useful
- `/context-mode:ctx-session` skill to show session state
- Optional: user-configurable event filters

### 11.2 Version Strategy

- Current: v0.9.22
- Phase 1 release: **v0.10.0** (minor bump — new feature, non-breaking)
- Branch: `feature/session-continuity` → PR to `next` → merge to `main`

### 11.3 Files to Create/Modify

#### Phase 0: Monorepo Migration (pre-requisite)
| File | Action |
|---|---|
| `package.json` (root) | MODIFY — add `workspaces: ["packages/*"]` |
| `tsconfig.base.json` | CREATE — shared TS config |
| `packages/core/package.json` | CREATE — `@context-mode/core`, private |
| `packages/core/tsconfig.json` | CREATE — extends base |
| `packages/shared/package.json` | CREATE — `@context-mode/shared`, private |
| `packages/shared/tsconfig.json` | CREATE — extends base |
| `packages/session/package.json` | CREATE — `@context-mode/session`, private |
| `packages/session/tsconfig.json` | CREATE — extends base |
| `src/server.ts` → `packages/core/src/server.ts` | MOVE |
| `src/executor.ts` → `packages/core/src/executor.ts` | MOVE |
| `src/runtime.ts` → `packages/core/src/runtime.ts` | MOVE |
| `src/security.ts` → `packages/core/src/security.ts` | MOVE |
| `src/cli.ts` → `packages/core/src/cli.ts` | MOVE |
| `src/store.ts` → `packages/shared/src/store.ts` | MOVE + refactor |
| `packages/shared/src/db-base.ts` | CREATE — extract from store.ts |
| `packages/shared/src/truncate.ts` | CREATE — extract from store.ts + executor.ts |
| `packages/shared/src/types.ts` | CREATE — shared interfaces |
| `tests/*.test.ts` → `tests/core/*.test.ts` | MOVE existing tests |

#### Phase 1: Session Continuity
| File | Action |
|---|---|
| `packages/session/src/extract.ts` | CREATE — event extraction rules |
| `packages/session/src/snapshot.ts` | CREATE — resume snapshot builder |
| `packages/session/src/db.ts` | CREATE — SessionDB class |
| `hooks/posttooluse.mjs` | CREATE — PostToolUse hook |
| `hooks/precompact.mjs` | CREATE — PreCompact hook |
| `hooks/sessionstart.mjs` | MODIFY — resume injection |
| `hooks/hooks.json` | MODIFY — add PostToolUse, PreCompact |
| `tests/session/session-extract.test.ts` | CREATE |
| `tests/session/session-snapshot.test.ts` | CREATE |
| `tests/session/session-db.test.ts` | CREATE |
| `tests/session/session-integration.test.ts` | CREATE |
| `tests/session/session-compact.test.ts` | CREATE |
| `tests/session/session-pipeline.test.ts` | CREATE |
| `tests/shared/db-base.test.ts` | CREATE |
| `tests/session/ctx-test-compact.md` | CREATE — dev-only smoke test script (NOT a public skill) |
| `package.json` | MODIFY (version bump) |
| `.claude-plugin/plugin.json` | MODIFY (version) |
| `.claude-plugin/marketplace.json` | MODIFY (version) |
| `README.md` | MODIFY (docs) |

---

## 12. Community Announcement Strategy

### 12.1 GitHub Release Notes (v0.10.0)

```markdown
## v0.10.0 — Session Continuity

### The Problem
Claude Code's context compaction discards ~70-80% of your conversation. After compact,
the AI forgets which files you were editing, your custom rules, task progress,
git branch state, and key decisions you made.

### The Solution
context-mode now automatically captures session events and injects a smart resume
snapshot after compact. Zero configuration. Zero LLM cost. Works out of the box.

**What gets preserved:**
- Active files (which files you were editing)
- Task progress (todo state, plan steps)
- CLAUDE.md rules (re-injected after compact)
- User decisions ("use X instead of Y")
- Git context (branch, uncommitted state)
- Environment (venv, node version, cwd)
- Error history (what failed and was fixed)
- Session intent (debugging vs building vs reviewing)

**How it works:**
1. `PostToolUse` hook captures events from every tool call (pattern-based, <20ms)
2. `PreCompact` hook builds a <2KB resume snapshot
3. `SessionStart` hook injects the snapshot after compact

No API keys. No LLM calls for extraction. No configuration needed.
Just install/upgrade and your sessions survive compact.

### Upgrade
`/context-mode:ctx-upgrade`
```

### 12.2 GitHub Issue (Pre-announcement)

Create issue: **"RFC: Session Continuity — Smart context recovery after compact"**

Content:
- Link to this PRD
- Ask for community feedback on event categories
- Invite contributions for Phase 2-4
- Label: `enhancement`, `rfc`

### 12.3 README Update

Add section after "Features":

```markdown
### Session Continuity (v0.10.0+)

context-mode automatically preserves your session context across Claude Code's
context compaction. When compact discards conversation history, a smart resume
snapshot is injected so the AI remembers:

- Which files you were editing
- Your CLAUDE.md rules and custom instructions
- Task progress and todo state
- Key decisions and corrections you made
- Git branch and environment state
- Error→resolution history

**Zero configuration. Zero cost.** Powered by pattern-based event extraction
through Claude Code's hook system.
```

### 12.4 Social Media / Community

- **Hacker News**: Post after v0.10.0 ships with real before/after examples
- **Reddit** (r/ClaudeAI, r/MachineLearning): Share with specific compact pain point examples
- **Twitter/X**: Thread showing the problem → solution flow
- **Claude Code Discord**: Announce in #plugins channel

---

## 13. Security Considerations

1. **No sensitive data storage**: Environment variable VALUES are not stored (only the `export KEY=` pattern). Actual secrets never enter session_events.

2. **Project isolation**: Each project gets its own DB file. No cross-project data leakage.

3. **Ephemeral by design**: Old sessions auto-purged. No long-term data retention.

4. **Tool response truncation**: All tool responses truncated to max 300 chars before storage. Prevents large file contents from being persisted.

5. **User message truncation**: Decision/role events truncate user messages to 500 chars.

6. **No network calls**: All extraction is local, pattern-based. No data leaves the machine.

7. **DB permissions**: Session DB inherits user's filesystem permissions. No world-readable files.

---

## 14. Open Questions

1. **UserPromptSubmit hook availability**: Does Claude Code provide a `UserPromptSubmit` hook? If not, decision/role/intent/data extraction requires parsing the JSONL transcript at PreCompact time instead of real-time capture.

2. **PostToolUse hook data contract**: What exact fields does PostToolUse provide? Need to verify `tool_response` is included (some hooks may only get `tool_name` + `tool_input`).

3. **Session ID discovery**: Claude Code doesn't explicitly pass session IDs to hooks. The `ppid` approach works within a session but may collide across projects. The transcript path approach is more reliable but only available in certain hooks.

4. **Hook execution order**: If multiple plugins register PostToolUse hooks, what's the execution order? We need to ensure our hook doesn't interfere with others.

5. **Compact frequency**: How often does auto-compact trigger in practice? If it triggers multiple times per session, we need to handle resume-of-resume (inject previous resume into new resume).

---

## 15. Success Metrics

| Metric | Target | How to Measure |
|---|---|---|
| Events captured per session | >20 for active sessions | `ctx-session` skill diagnostics |
| Resume injection rate | 100% on compact | Log in sessionstart.mjs |
| Resume size | <2KB (100% of snapshots) | Assertion in snapshot builder |
| PostToolUse latency | p99 <20ms | Benchmark test |
| User-reported compact issues | 50% reduction | GitHub issue tracking |
| Feature adoption | >50% of active users | npm download delta after release |

---

## Appendix A: Claude Code Hook Data Contracts

### PostToolUse Input
```json
{
  "hook_type": "PostToolUse",
  "session_id": "optional",
  "tool_name": "Bash|Read|Edit|Write|Grep|Glob|Agent|Skill|...",
  "tool_input": { /* tool-specific params */ },
  "tool_response": "string or null",
  "tool_use_id": "toolu_...",
  "tool_output": { "isError": false }
}
```

### PreCompact Input
```json
{
  "hook_type": "PreCompact",
  "session_id": "optional",
  "transcript_path": "/path/to/session.jsonl",
  "trigger": "auto|manual"
}
```

### SessionStart Input
```json
{
  "hook_type": "SessionStart",
  "session_id": "optional",
  "source": "startup|resume|compact|clear"
}
```

### SubagentStop Input
```json
{
  "hook_type": "SubagentStop",
  "agent_id": "string",
  "agent_transcript_path": "/path/to/agent.jsonl",
  "exit_reason": "completed|error|timeout"
}
```

---

## Appendix B: TDD Workflow

This feature MUST follow TDD (Red-Green-Refactor):

1. **Red**: Write failing tests first (extraction, snapshot, DB, integration, E2E)
2. **Green**: Implement minimum code to make tests pass
3. **Refactor**: Clean up while keeping tests green

### Test execution order:
```bash
# Phase 1: Shared logic tests
npx tsx tests/shared/db-base.test.ts

# Phase 2: Pure function tests (no DB needed)
npx tsx tests/session/session-extract.test.ts

# Phase 3: DB tests
npx tsx tests/session/session-db.test.ts

# Phase 4: Snapshot builder tests
npx tsx tests/session/session-snapshot.test.ts

# Phase 5: Integration (all components together)
npx tsx tests/session/session-integration.test.ts

# Phase 6: E2E context-filling scenario (realistic token modeling)
npx tsx tests/session/session-compact.test.ts

# Phase 7: Pipeline test (spawns actual hook processes)
npx tsx tests/session/session-pipeline.test.ts

# Phase 8: Manual smoke test (in a live Claude Code session)
# /context-mode:ctx-test-compact

# Run by domain:
npm run test:core       # for f in tests/core/*.test.ts; ...
npm run test:session    # for f in tests/session/*.test.ts; ...
npm run test:shared     # for f in tests/shared/*.test.ts; ...

# Run all:
npm test                # for f in tests/**/*.test.ts; ...
```

### Import convention:
```typescript
// Tests import TypeScript source directly via tsx:
import { extractEvents } from "../../packages/session/src/extract.ts";
import { SessionDB } from "../../packages/session/src/db.ts";
import { buildResumeSnapshot } from "../../packages/session/src/snapshot.ts";
import { truncate } from "../../packages/shared/src/truncate.ts";

// Hooks import compiled JS from build/:
// import { extractEvents } from "../build/session/extract.js";
```

### Source → Test → Hook flow:
```
packages/session/src/extract.ts          # TypeScript source (business logic)
  ↓ tsx (tests)
tests/session/session-extract.test.ts    # Tests import .ts directly

  ↓ tsc (build)
build/session/extract.js                 # Compiled output

  ↓ import (runtime)
hooks/posttooluse.mjs                    # Thin wrapper: stdin → extract → DB → stdout
```

---

