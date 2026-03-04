# Session Continuity — Test Guide

## PostToolUse Event Capture Test Matrix

After restarting Claude Code, run each prompt and then verify with the DB check query below.

### DB Check Query
```bash
sqlite3 ~/.claude/context-mode/sessions/*.db \
  "SELECT id, category, type, substr(data,1,60), data_hash FROM session_events ORDER BY id;"
```

### Test Prompts

| # | Category | Tool | Test Prompt | Expected Event |
|---|----------|------|-------------|----------------|
| 1 | file | Read | `Read package.json and tell me the version` | `file_read \| .../package.json` |
| 2 | file | Edit | `Add a blank line at the end of README.md then remove it` | `file \| .../README.md` |
| 3 | file | Grep | `Search for "VERSION" in src/server.ts` | `file_search \| VERSION in .../server.ts` |
| 4 | file | Glob | `Find all *.test.ts files under tests/` | `file_glob \| tests/*.test.ts` (or similar) |
| 5 | git | Bash | `Run git log --oneline -3` | `git \| log` |
| 6 | git | Bash | `Run git status` | `git \| status` |
| 7 | env | Bash | `Run export NODE_ENV=test` | `env \| export NODE_ENV=test` |
| 8 | rule | Read | `Read the CLAUDE.md file: @CLAUDE.md` | `rule \| .../CLAUDE.md` + `rule_content \| <first 500 chars>` |
| 9 | mcp | MCP | `Use context-mode batch_execute to run "echo hello"` | `mcp \| batch_execute: ...` |
| 10 | mcp | MCP | `/context-mode:ctx-stats` | `mcp \| stats` |
| 11 | task | Task | `Create a task: "Test session continuity"` | `task \| {"subject":...}` |
| 12 | skill | Skill | `/context-mode:ctx-doctor` | `skill \| context-mode:ctx-doctor` |
| 13 | error | Bash | `Run: bash -c "exit 1"` | `error_tool \| ...exit code 1...` |
| 14 | cwd | Bash | `Run: cd /tmp` | `cwd \| /tmp` |
| 15 | subagent | Agent | `Use an agent to find all TODO comments in the codebase` | `subagent \| find all TODO...` |

### Quick All-in-One Test

Run these 4 commands to trigger the most common events, then check DB:

```
1. Read package.json
2. Search for "VERSION" in src/server.ts
3. Find all *.ts files under packages/
4. Run git log --oneline -5
```

Then verify:
```bash
sqlite3 ~/.claude/context-mode/sessions/*.db \
  "SELECT type, COUNT(*) FROM session_events GROUP BY type ORDER BY type;"
```

Expected output should include: `file_read`, `file_search`, `file_glob`, `git`, `mcp` (from any MCP tool calls made during the session).

---

## PreCompact (Snapshot) Testing

The PreCompact hook fires when Claude Code compacts the conversation (context window approaching limit). This builds a `<session_resume>` XML snapshot from all captured events.

### How to Trigger Compaction

**Method 1: Natural compaction (recommended)**
Keep working in a long session. After ~50-80 tool calls or when context fills up, Claude Code will automatically compact. You'll see:
```
SessionStart:resume hook success: Success
```

**Method 2: Force compaction**
Send a very long message (paste a large file) to fill the context window faster. Then continue working — compaction will trigger sooner.

### What to Verify After Compaction

1. **Resume snapshot was built:**
```bash
sqlite3 ~/.claude/context-mode/sessions/*.db \
  "SELECT session_id, event_count, consumed, substr(snapshot,1,200) FROM session_resume;"
```

2. **Compact count incremented:**
```bash
sqlite3 ~/.claude/context-mode/sessions/*.db \
  "SELECT session_id, compact_count FROM session_meta;"
```

3. **Resume was injected (check SessionStart output):**
After compaction, the next response should include `<session_resume>` in the context. Check the debug log:
```bash
cat ~/.claude/context-mode/sessionstart-debug.log 2>/dev/null | tail -5
```

4. **CLAUDE.md rules survived compact:**
After compaction, ask: "What are my project rules from CLAUDE.md?" — Claude should be able to answer from the `<rules>` section in the resume snapshot.

5. **MCP tools in snapshot:**
If you used MCP tools (context-mode, context7, playwright), they should appear in `<mcp_tools>` section:
```bash
sqlite3 ~/.claude/context-mode/sessions/*.db \
  "SELECT substr(snapshot,1,500) FROM session_resume;" | grep -o '<mcp_tools>.*</mcp_tools>'
```

### Snapshot Structure (expected XML)

```xml
<session_resume compact_count="1" events_captured="25" generated_at="...">
  <active_files>
    <file path="/path/to/file.ts" ops="read:3,edit:1" last="edit" />
  </active_files>
  <rules>
    - /path/to/CLAUDE.md
    <rule_content>First 400 chars of CLAUDE.md content...</rule_content>
  </rules>
  <decisions>
    - User correction or preference...
  </decisions>
  <environment>
    <cwd>/project/dir</cwd>
    <git op="commit" />
  </environment>
  <intent mode="implement">implement</intent>
  <mcp_tools>
    <tool name="batch_execute" calls="5" />
    <tool name="search" calls="2" />
  </mcp_tools>
</session_resume>
```

---

## Debug Logs

All hooks write debug logs to `~/.claude/context-mode/`:

| Hook | Log File | What It Shows |
|------|----------|---------------|
| PostToolUse | `posttooluse-debug.log` | `CALL: <tool>` + `OK: <tool> → N events` or `ERR: ...` |
| PreCompact | `precompact-debug.log` | Snapshot build success/failure |
| SessionStart | `sessionstart-debug.log` | Resume injection success/failure |

### Tail all logs in real-time
```bash
tail -f ~/.claude/context-mode/*-debug.log
```
