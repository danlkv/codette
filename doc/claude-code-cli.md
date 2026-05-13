# Claude Code CLI Reference

## Invocation

```
claude [prompt]          # interactive REPL
claude -p [prompt]       # non-interactive (--print), exits after response
claude -p < file.txt     # stdin as prompt
```

## Key Flags

| Flag | Type | Notes |
|------|------|-------|
| `-p` / `--print` | bool | Non-interactive; requires `--output-format=stream-json` with `--verbose` |
| `--output-format` | `text`\|`json`\|`stream-json` | `stream-json` emits JSONL events to stdout |
| `--verbose` | bool | With `stream-json`: emits all events including thinking blocks |
| `--include-partial-messages` | bool | Emit partial assistant events mid-stream |
| `--model` | string | Model ID or alias (`sonnet`, `opus`, `haiku`) |
| `--resume` | string\|bool | Resume session by ID; bare flag resumes last |
| `--continue` | bool | Continue last session (equivalent to `--resume` with last session) |
| `--max-turns` | number | Limit agentic turns before stopping |
| `--allowed-tools` | string[] | Whitelist specific tools |
| `--permission-mode` | string | See below |
| `--dangerously-skip-permissions` | bool | Required to enable `bypassPermissions` mode |
| `--system-prompt` | string | Replace system prompt |
| `--append-system-prompt` | string | Append to system prompt |
| `--add-dir` | string | Add directory to allowed paths |

## Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Prompt user for each tool |
| `acceptEdits` | Auto-approve file edits |
| `bypassPermissions` | Skip all checks (requires `--dangerously-skip-permissions`) |
| `plan` | No tool execution; planning only |
| `dontAsk` | Deny unapproved tools silently |

## Session Storage

```
$CLAUDE_CONFIG_DIR/projects/<sanitized-cwd>/<session-id>.jsonl
# default: ~/.claude/projects/...
```

Sub-agent transcripts:
```
~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.jsonl
```

## Output Formats

**`text`** (default interactive): plain terminal output
**`json`** with `--verbose`: single JSON array of all messages on exit
**`stream-json`**: JSONL events emitted as they arrive — see `claude-jsonl.md`

## Compact (Context Management)

Triggered automatically near context limit, or manually via `/compact`.
Uses same model (`mainLoopModel`) via a **forked agent** that piggybacks the main conversation's prompt cache prefix (`tengu_compact_cache_prefix` feature flag, default on). Falls back to direct `queryModelWithStreaming` on failure.
Summary injected as a user message at the start of the resumed context; `<analysis>` scratchpad stripped before injection.

## Slash Command Dispatch

Three execution levels (see `processSlashCommand.tsx`):

| `command.type` | Execution | Examples |
|----------------|-----------|---------|
| `local-jsx` | Renders React JSX in terminal UI | `/help`, `/settings` |
| `local` | In-process TS function, no model call | `/clear`, `/compact`, `/exit` |
| `prompt` | Spawns sub-agent via `runAgent()` | `/commit`, all skills |

Skills with `userInvocable: false` can only be invoked by the model via `SkillTool`, not directly by users.

## Environment Variables

| Var | Effect |
|-----|--------|
| `CLAUDE_CONFIG_DIR` | Override `~/.claude` config/storage root |
| `ANTHROPIC_API_KEY` | API key |
| `ANTHROPIC_BASE_URL` | API base URL override |
| `USER_TYPE` | Set to `ant` for internal Anthropic paths |
