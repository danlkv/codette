# Claude JSONL Event Reference

Examples: `doc/example-stream.jsonl`, `doc/example-session.jsonl` (session `37f7e056`, "username + date, two bash commands")

---

## Two Views of the Same Event

`assistant` and `user[tool_result]` appear in both stream and session with the **same `uuid`** (and `message.id` for assistant). Session is the enriched/final version.

| Field | stream | session |
|-------|--------|---------|
| wrapper | `parent_tool_use_id`, `session_id` | full envelope |
| `message.stop_reason` | `null` | `"end_turn"` \| `"tool_use"` |
| `message.usage` | partial (no `output_tokens`) | complete |
| `requestId`, `timestamp` | absent on assistant | present |

---

## Common Envelope _(all persisted except `queue-operation`, `ai-title`, `last-prompt`)_

```ts
{
  parentUuid:  string | null
  isSidechain: boolean
  userType:    string          // "external"
  entrypoint:  string          // "sdk-cli" | "cli" | ...
  cwd:         string
  sessionId:   string          // UUID v4
  version:     string          // e.g. "2.1.123"
  gitBranch:   string
  slug?:       string          // absent on newer sessions
  uuid:        string          // UUID v4
  timestamp:   string          // ISO8601
}
```

---

## Event Types

### `queue-operation` _(session)_
```ts
{
  type:       "queue-operation"
  operation:  "enqueue" | "dequeue"
  timestamp:  string            // ISO8601
  sessionId:  string
  content?:   string            // user text, enqueue only
}
```
Two per user turn: `enqueue` on arrival, `dequeue` on processing start.

---

### `user` _(stream + session)_

**Stream** — tool results only (initial user message not emitted in stream)
```ts
{
  type:              "user"
  parent_tool_use_id: string | null
  session_id:        string
  uuid:              string
  timestamp:         string
  message:           { role: "user", content: ToolResultBlock[] }
  tool_use_result?:  ToolUseResult
}
```

**Session — initial**
```ts
{
  type:           "user"
  ...envelope
  promptId:       string
  permissionMode: string        // "bypassPermissions" | "default" | ...
  message:        { role: "user", content: string }
}
```

**Session — tool result**
```ts
{
  type:                   "user"
  ...envelope
  sourceToolAssistantUUID: string
  message:                { role: "user", content: ToolResultBlock[] }
  toolUseResult?:         ToolUseResult
}
```

```ts
type ToolResultBlock = {
  type:        "tool_result"
  tool_use_id: string
  content:     string
  is_error:    boolean
}

type ToolUseResult =
  | { stdout: string, stderr: string, interrupted: boolean, isImage: boolean, noOutputExpected: boolean }  // Bash
  | { filePath: string, oldString: string, newString: string, originalFile: string }                       // Edit
```

---

### `attachment` _(session)_
```ts
{
  type:       "attachment"
  ...envelope
  attachment:
    | { type: "deferred_tools_delta", addedNames: string[], addedLines: string[], removedNames: string[] }
    | { type: "skill_listing", content: string, skillCount: number, isInitial: boolean }
}
```

---

### `ai-title` _(session)_
```ts
{ type: "ai-title", aiTitle: string, sessionId: string }  // no uuid
```

### `last-prompt` _(session)_
```ts
{ type: "last-prompt", lastPrompt: string, leafUuid: string, sessionId: string }  // no uuid
```

---

### `assistant` _(stream + session)_

**Stream wrapper**
```ts
{
  type:               "assistant"
  parent_tool_use_id: string | null
  session_id:         string
  uuid:               string
  message:            Message
}
```

**Session wrapper**
```ts
{
  type:      "assistant"
  ...envelope
  requestId: string              // "req_..."
  message:   Message             // stop_reason/usage complete
}
```

```ts
type Message = {
  id:            string          // "msg_..."
  model:         string
  type:          "message"
  role:          "assistant"
  content:       ContentBlock[]
  stop_reason:   null | "end_turn" | "tool_use"   // null in stream partial
  stop_sequence: null
  stop_details:  null | object
  usage:         Usage
  diagnostics:   null
}
```

---

## Content Blocks

```ts
type ContentBlock =
  | { type: "text",     text: string }
  | { type: "thinking", thinking: string, signature: string }   // signature = base64 opaque token
  | { type: "tool_use", id: string, name: string, input: ToolInput, caller: { type: "direct" | "mcp" } }
  | { type: "tool_result", tool_use_id: string, content: string, is_error: boolean }

type ToolInput =
  | { command: string, description?: string, timeout?: number }                           // Bash
  | { file_path: string, offset?: number, limit?: number }                                // Read
  | { file_path: string, old_string: string, new_string: string, replace_all?: boolean }  // Edit
  | { file_path: string, content: string }                                                // Write
  | { pattern: string, path?: string, glob?: string }                                     // Grep
```

---

## Usage
```ts
type Usage = {
  input_tokens:                number
  cache_creation_input_tokens: number
  cache_read_input_tokens:     number
  output_tokens?:              number   // absent in stream partial
  server_tool_use:             { web_search_requests: number, web_fetch_requests: number }
  cache_creation:              { ephemeral_5m_input_tokens: number, ephemeral_1h_input_tokens: number }
  iterations:                  object[]
  speed:                       string
  service_tier:                string
  inference_geo:               string
}
```

---

### `progress` _(session)_

```ts
// bash_progress — emitted every ~3s while Bash runs
{
  type:            "progress"
  ...envelope
  toolUseID:       "bash-progress-0"   // synthetic placeholder, not a real toolu_ id
  parentToolUseID: string              // actual Bash toolu_... id
  data: {
    type:               "bash_progress"
    output:             string
    fullOutput:         string
    elapsedTimeSeconds: number
    totalLines:         number
    totalBytes:         number
    taskId:             string
    timeoutMs:          number
  }
}

// hook_progress — on PostToolUse/PreToolUse hook
{
  type:            "progress"
  ...envelope
  toolUseID:       string              // same as parentToolUseID
  parentToolUseID: string
  data: {
    type:      "hook_progress"
    hookEvent: string                  // "PostToolUse" | "PreToolUse" | ...
    hookName:  string                  // e.g. "PostToolUse:Grep"
    command:   "callback"
  }
}
```

---

### `system` _(stream)_
```ts
{
  type:                "system"
  subtype:             "init"
  uuid:                string
  session_id:          string
  cwd:                 string
  model:               string
  permissionMode:      string
  tools:               string[]
  mcp_servers:         object[]
  slash_commands:      string[]
  agents:              string[]
  skills:              string[]
  plugins:             object[]
  apiKeySource:        string
  claude_code_version: string
  output_style:        string
  analytics_disabled:  boolean
  memory_paths:        { auto: string }
  fast_mode_state:     string
}
```

---

### `result` _(stream)_
```ts
{
  type:              "result"
  subtype:           "success" | "error" | "interrupted"
  uuid:              string
  is_error:          boolean
  api_error_status:  null | object
  session_id:        string
  duration_ms:       number
  duration_api_ms:   number
  num_turns:         number
  result:            string
  stop_reason:       "end_turn" | "tool_use"
  total_cost_usd:    number
  usage:             Usage
  modelUsage:        Record<string, {
    inputTokens:              number
    outputTokens:             number
    cacheReadInputTokens:     number
    cacheCreationInputTokens: number
    webSearchRequests:        number
    costUSD:                  number
    contextWindow:            number
    maxOutputTokens:          number
  }>
  permission_denials: object[]
  terminal_reason:    string
  fast_mode_state:    string
}
```

---

## Turn Lifecycle

### Stream
```
system(init)
  assistant[thinking]
  assistant[text]?
  assistant[tool_use]
  user[tool_result]        // has timestamp + tool_use_result
  assistant[tool_use]?  ┐
  user[tool_result]?    ┘ repeat
  assistant[text]
result
```

### Session
```
queue-operation(enqueue)
queue-operation(dequeue)
user(string)
  attachment(deferred_tools_delta)
  attachment(skill_listing)
  ai-title
  assistant[thinking?][text?][tool_use?]   // same uuid as stream
    progress(bash_progress)*
    progress(hook_progress)*
    user(tool_result)                      // same uuid as stream
    assistant[tool_use?][text?]
    ...
  last-prompt
  ai-title
```

### Content block ordering per assistant event
```
thinking? → text? → tool_use*
```
Each block type arrives as its own separate event (`--include-partial-messages`). Text and tool_use are single complete events, not incremental.

---

## ID Reference

| Field | Format | Notes |
|-------|--------|-------|
| `sessionId`/`session_id` | UUID v4 | |
| `uuid` | UUID v4 | matches across stream + session |
| `parentUuid` | UUID v4 | previous event in tree |
| `promptId` | UUID v4 | user turn |
| `message.id` | `msg_...` | matches across stream + session |
| `tool_use.id` | `toolu_...` | |
| `requestId` | `req_...` | session only |
| `progress.toolUseID` (bash) | `"bash-progress-0"` | synthetic; not unique per call |
| `progress.taskId` | alphanumeric | internal scheduler |
