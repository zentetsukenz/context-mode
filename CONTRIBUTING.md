# Contributing to context-mode

This project is licensed under the Elastic License 2.0 (ELv2) and moves forward with your support. Every issue, every PR, every idea matters.

Don't overthink it. Don't ask yourself "is my PR good enough?" or "is this issue too small?" -- just send it. A rough draft beats a perfect plan that never ships. If you found a bug, report it. If you have an idea, open an issue. If you wrote a fix, submit the PR.

That said, I'm a solo maintainer with limited time. The best way to help me help you: follow the templates, include your `/context-mode:ctx-doctor` output, and write tests for your changes. The more context you give me, the faster I can review.

I genuinely love open source and I'm grateful to have you here. Don't hesitate to reach out -- whether it's a question, a suggestion, or just to say hi. Let's build this together.

---

This guide covers the local development workflow so you can test changes in a live Claude Code session before submitting a PR.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed
- Node.js 20+ or [Bun](https://bun.sh/) (recommended for speed)
- context-mode plugin installed via marketplace

## Local Development Setup

### 1. Clone and install

```bash
git clone https://github.com/mksglu/claude-context-mode.git
cd claude-context-mode
npm install
npm run build
```

### 2. Symlink the cache to your local clone

Claude Code's plugin system manages `~/.claude/plugins/installed_plugins.json` and **will revert manual edits on restart**. The reliable approach is to replace the cache directory with a symlink to your local clone.

First, find your cached version:

```bash
ls ~/.claude/plugins/cache/claude-context-mode/context-mode/
# Example output: 0.9.22
```

Then replace it with a symlink:

```bash
# Back up the cache (use your actual version number)
mv ~/.claude/plugins/cache/claude-context-mode/context-mode/0.9.22 \
   ~/.claude/plugins/cache/claude-context-mode/context-mode/0.9.22.bak

# Symlink to your local clone
ln -s /path/to/your/clone/claude-context-mode \
   ~/.claude/plugins/cache/claude-context-mode/context-mode/0.9.22
```

Replace `/path/to/your/clone/claude-context-mode` with your actual local path.

> **Why symlink?** The plugin system overwrites `installed_plugins.json` on every session start, reverting any manual path changes. A symlink lets the plugin system keep its managed path while the actual code resolves to your local clone.

### 3. Update PreToolUse hook in settings

The symlink in step 2 ensures `hooks.json` (which registers PostToolUse, PreCompact, and SessionStart) resolves to your local clone via the plugin system. You only need to override PreToolUse in `~/.claude/settings.json` since its broader matcher is needed for dev mode:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Grep|WebFetch|Task|mcp__plugin_context-mode_context-mode__execute|mcp__plugin_context-mode_context-mode__execute_file|mcp__plugin_context-mode_context-mode__batch_execute",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/your/clone/claude-context-mode/hooks/pretooluse.mjs"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/your/clone/claude-context-mode` with your actual local path.

> **Important:** Do NOT add PostToolUse, PreCompact, or SessionStart to `settings.json` — they are already registered in `hooks.json` and the symlink makes them resolve to your local clone. Adding them to both causes double invocations, split session IDs, and SQLite locking errors.

### 4. Bump the version for verification

Change the version in your local clone to something recognizable:

```bash
# In package.json: "version": "0.9.22-dev"
# In src/server.ts: const VERSION = "0.9.22-dev";
```

Then rebuild:

```bash
npm run build
```

### 5. Kill cached MCP processes and restart

```bash
# Kill any running context-mode processes
pkill -f "context-mode.*start.mjs"

# Verify no processes remain
ps aux | grep context-mode | grep -v grep
# Should return nothing
```

Restart Claude Code (`/exit` then `claude`).

### 6. Verify local dev mode

Run `/context-mode:ctx-doctor` in Claude Code. You should see your dev version:

```
npm (MCP): WARN — local v0.9.22-dev, latest v0.9.22
```

The version warning is expected -- it confirms you're running from your local clone, not the cache.

### Restoring marketplace version

To switch back to the marketplace version:

```bash
# Remove symlink and restore backup
rm ~/.claude/plugins/cache/claude-context-mode/context-mode/0.9.22
mv ~/.claude/plugins/cache/claude-context-mode/context-mode/0.9.22.bak \
   ~/.claude/plugins/cache/claude-context-mode/context-mode/0.9.22
```

Then revert hooks in `~/.claude/settings.json` and restart Claude Code.

## Development Workflow

### Build and test your changes

```bash
# TypeScript compilation
npm run build

# Run all tests (parallel via Vitest)
npm test

# Type checking only
npm run typecheck

# Watch mode
npm run test:watch
```

### See changes in Claude Code

After modifying source code:

```bash
npm run build
```

Then restart your Claude Code session. The MCP server reloads on session start.

## TDD Workflow

We follow test-driven development. Every PR must include tests.

**We strongly recommend installing the [TDD skill](https://github.com/anthropics/claude-code-skills) for Claude Code** -- it enforces the red-green-refactor loop automatically.

### Red-Green-Refactor

1. **Red** -- Write a failing test for the behavior you want
2. **Green** -- Write the minimum code to make it pass
3. **Refactor** -- Clean up while keeping tests green

### Output quality matters

When your change affects tool output (execute, search, fetch_and_index, etc.), always compare before and after:

1. Run the same prompt **before** your change (on `main`)
2. Run it **again** with your change
3. Include both outputs in your PR

## Submitting a Bug Report

When filing a bug, **always include your prompt**. The exact message you sent to Claude Code is critical for reproduction. Without it, we can't debug the issue.

Required information:
- `/context-mode:ctx-doctor` output (must be latest version)
- The prompt that triggered the bug
- Debug logs from `Ctrl+O` (background tool calls and MCP communication)

## Submitting a Pull Request

1. Fork the repository
2. Create a feature branch from `main`
3. Follow the local development setup above
4. Write tests first (TDD)
5. Run `npm test` and `npm run typecheck`
6. Test in a live Claude Code session
7. Compare output quality before/after
8. Open a PR using the template

## Quick Reference

| Task | Command |
|---|---|
| Check version | `/context-mode:ctx-doctor` |
| Upgrade plugin | `/context-mode:ctx-upgrade` |
| View session stats | `/context-mode:ctx-stats` |
| See background steps | `Ctrl+O` |
| Kill cached server | `pkill -f "context-mode.*start.mjs"` |
| Rebuild after changes | `npm run build` |
| Run all tests | `npm test` |
| Watch mode | `npm run test:watch` |
