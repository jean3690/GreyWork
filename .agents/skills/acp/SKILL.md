---
name: Acp
description: Use when implementing agents or clients that communicate via the Agent Client Protocol, building integrations between code editors and AI coding agents, or extending ACP with custom capabilities and transports. Reach for this skill when working with protocol initialization, session management, tool calls, authentication, or implementing bidirectional JSON-RPC communication.
metadata:
    mintlify-proj: acp
    version: "1.0"
---

# Agent Client Protocol (ACP) Skill

## Product Summary

The Agent Client Protocol (ACP) is a standardized JSON-RPC 2.0 specification for bidirectional communication between code editors/IDEs and AI coding agents. It decouples agents from editors, allowing any ACP-compatible agent to work with any ACP-compatible client. Agents typically run as subprocesses communicating over stdio; remote agents can use HTTP or WebSocket transports. The protocol reuses MCP types where possible and uses Markdown for user-readable text. Primary documentation: https://agentclientprotocol.com. Key files: protocol specifications (v1 stable, v2 draft), JSON-RPC schema, transport definitions, and SDK libraries (TypeScript, Python, Rust, Kotlin, Java).

## When to Use

Reach for this skill when:
- **Building an agent** that needs to work with multiple editors or clients
- **Building a client** (editor, IDE, or UI) that needs to support multiple agents
- **Implementing protocol features** like session management, tool calls, authentication, or file system access
- **Extending ACP** with custom capabilities, methods, or transports
- **Debugging protocol interactions** between agents and clients
- **Choosing between v1 (stable) and v2 (draft)** protocol versions
- **Integrating MCP servers** into agent-client communication
- **Handling authentication flows** (protocol-driven or terminal-based)

## Quick Reference

### Core Protocol Flow

| Phase | Client Action | Agent Response |
|-------|---------------|-----------------|
| **Initialize** | Send `initialize` with protocol version and capabilities | Respond with negotiated version and supported capabilities |
| **Authenticate** | Call `authenticate` (if required) or run terminal login | Return empty result on success |
| **Session Setup** | Call `session/new`, `session/load`, or `session/resume` | Return `sessionId` or restore context |
| **Prompt Turn** | Send `session/prompt` with user message | Stream `session/update` notifications, handle tool calls, respond with `stopReason` |
| **Cleanup** | Call `session/close` or `session/delete` | Free resources and respond |

### Essential Methods

**Agent Methods (Client calls these):**
- `initialize` - Negotiate protocol version and capabilities
- `authenticate` - Protocol-driven authentication (if `authMethods` advertised)
- `session/new` - Create new session
- `session/prompt` - Send user message
- `session/load` - Resume session with history replay (if `loadSession` capability)
- `session/resume` - Resume session without replay (if `sessionCapabilities.resume`)
- `session/close` - Close active session (if `sessionCapabilities.close`)
- `session/delete` - Delete session (if `sessionCapabilities.delete`)
- `session/list` - List known sessions (if `sessionCapabilities.list`)
- `session/cancel` - Cancel ongoing work (notification)
- `logout` - End authenticated state (if `auth.logout` capability)

**Client Methods (Agent calls these):**
- `session/request_permission` - Ask user to approve tool execution
- `fs/read_text_file` - Read file (if `fs.readTextFile` capability)
- `fs/write_text_file` - Write file (if `fs.writeTextFile` capability)
- `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` - Terminal operations (if `terminal` capability)
- `elicitation/create` - Request structured user input (if matching `elicitation` mode capability)

### Capability Negotiation

Check capabilities in `initialize` response before calling optional methods:

```json
{
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": true },
    "auth": { "logout": {} },
    "sessionCapabilities": {
      "resume": {},
      "close": {},
      "delete": {},
      "additionalDirectories": {}
    },
    "mcpCapabilities": { "http": true, "sse": true }
  }
}
```

### Session Lifecycle

| Method | When to Use | Replays History? | Requires Capability |
|--------|------------|------------------|---------------------|
| `session/new` | Create new conversation | N/A | None (baseline) |
| `session/load` | Resume with full history | Yes | `loadSession` |
| `session/resume` | Reconnect without replay | No | `sessionCapabilities.resume` |
| `session/close` | Stop active session | N/A | `sessionCapabilities.close` |

### Tool Call Lifecycle

```
pending → in_progress → completed/failed
```

Tool call kinds: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `other`

Tool call content types: `content` (text/image/etc), `diff` (file changes), `terminal` (live output)

### Transport Support

| Transport | Default? | When to Use | Notes |
|-----------|----------|------------|-------|
| **stdio** | Yes | Local agents as subprocesses | Messages delimited by newlines, no embedded newlines |
| **HTTP** | Draft | Remote agents, serverless | Streamable HTTP with SSE or WebSocket upgrade |
| **Custom** | No | Special requirements | Must preserve JSON-RPC format |

## Decision Guidance

### When to Use v1 vs v2

| Aspect | v1 (Stable) | v2 (Draft) |
|--------|-----------|-----------|
| **Status** | Production-ready | In development, may change |
| **Use when** | Building stable integrations | Experimenting with new features |
| **Prompt model** | `session/prompt` returns response | `session/prompt` returns immediately, updates via `session/update` |
| **Tool calls** | Full replacement on update | Patch semantics with content chunks |
| **Auth** | `authenticate` method | `auth/login` and `auth/logout` methods |
| **Session list** | Not available | `session/list` method |

### When to Use session/load vs session/resume

| Scenario | Use `session/load` | Use `session/resume` |
|----------|-------------------|---------------------|
| User wants full conversation history | ✓ | ✗ |
| User just reconnected, wants to continue | ✓ | ✓ (faster) |
| Agent doesn't support resume | ✓ | ✗ |
| Performance critical | ✗ | ✓ |

### When to Request Permission vs Auto-Execute

| Situation | Request Permission | Auto-Execute |
|-----------|-------------------|--------------|
| Destructive operation (delete, modify) | ✓ | ✗ |
| Requires external API call | ✓ | ✗ |
| Read-only operation | ✗ | ✓ |
| User has auto-approve setting | ✗ | ✓ |

### When to Use Custom Capabilities vs Extension Methods

| Need | Custom Capabilities | Extension Methods |
|------|-------------------|-------------------|
| Advertise feature support | ✓ | ✗ |
| Add new RPC method | ✗ | ✓ (prefix with `_`) |
| Attach metadata | ✓ (use `_meta`) | ✗ |
| Negotiate during init | ✓ | ✗ |

## Workflow

### Implementing an Agent

1. **Set up JSON-RPC server** - Listen for client connections over stdio (or custom transport)
2. **Implement `initialize`** - Advertise protocol version and capabilities; include `agentInfo`
3. **Implement authentication** (if needed) - Advertise `authMethods` and handle `authenticate` or `logout`
4. **Implement session management** - Handle `session/new`, optionally `session/load`/`session/resume`/`session/close`
5. **Implement prompt handling** - Receive `session/prompt`, stream `session/update` notifications with agent messages and tool calls
6. **Handle tool execution** - Report tool calls with status updates; optionally request permission via `session/request_permission`
7. **Use client capabilities** - Call `fs/read_text_file`, `fs/write_text_file`, `terminal/*` methods as needed
8. **Handle cancellation** - Listen for `session/cancel` notifications and abort work gracefully

### Implementing a Client

1. **Launch agent subprocess** - Start agent process, connect to stdio
2. **Send `initialize`** - Advertise protocol version and client capabilities; include `clientInfo`
3. **Handle authentication** - Check `authMethods` in response; call `authenticate` or launch terminal login
4. **Create or resume session** - Call `session/new` or `session/load`/`session/resume`
5. **Send user prompts** - Call `session/prompt` with user message and content
6. **Handle `session/update` notifications** - Display agent messages, tool calls, plans, usage updates
7. **Implement permission requests** - Listen for `session/request_permission`, show UI, respond with user choice
8. **Implement client methods** - Respond to `fs/read_text_file`, `fs/write_text_file`, `terminal/*`, `elicitation/*` calls
9. **Handle cancellation** - Send `session/cancel` notification when user stops execution
10. **Clean up** - Call `session/close` or `session/delete` when done

### Debugging Protocol Issues

1. **Check capability negotiation** - Verify both sides advertise required capabilities in `initialize`
2. **Validate JSON-RPC format** - Ensure all messages are valid JSON-RPC 2.0 (requests have `id`, notifications don't)
3. **Trace message flow** - Log all messages to understand where communication breaks
4. **Check error responses** - Look for JSON-RPC error objects with `code` and `message`
5. **Verify file paths** - Ensure all paths are absolute (required by spec)
6. **Test with reference implementations** - Use SDK examples to isolate issues

## Common Gotchas

- **Forgetting to check capabilities before calling optional methods** - Always verify the capability in `initialize` response before calling `session/load`, `session/resume`, `fs/read_text_file`, etc. Calling unsupported methods causes errors.
- **Mixing up v1 and v2 protocol versions** - v1 and v2 are incompatible. Negotiate the version during `initialize` and stick to it. Don't mix v1 and v2 message formats.
- **Sending embedded newlines in stdio transport** - Messages over stdio must be delimited by single newlines with no embedded newlines. Use JSON escaping for multiline content.
- **Not handling notifications properly** - Notifications (no `id` field) never receive responses. Don't try to respond to `session/update` or `session/cancel`.
- **Forgetting to respond to permission requests** - If agent calls `session/request_permission`, client must respond with `outcome` (either `selected` with `optionId` or `cancelled`). Leaving it hanging breaks the turn.
- **Using relative paths** - All file paths in the protocol must be absolute. Relative paths cause undefined behavior.
- **Not catching tool execution errors during cancellation** - When `session/cancel` is sent, tool execution may throw exceptions. Catch these and return `stopReason: "cancelled"` instead of propagating the error.
- **Assuming session state persists across reconnects** - Unless the agent explicitly supports `session/resume` or `session/load`, session state is lost. Always check capabilities.
- **Sending tool calls without status updates** - Report tool calls with `status: "pending"`, then update to `in_progress` and finally `completed`/`failed`. Skipping status updates confuses clients.
- **Not handling `_meta` fields** - Unknown `_meta` fields should be preserved and forwarded. Don't strip them out.
- **Mixing authentication methods** - Don't call both `authenticate` and terminal login for the same method. Check the method's `type` field to determine the flow.
- **Forgetting to handle concurrent sessions** - A single connection can have multiple concurrent sessions. Track `sessionId` carefully and don't mix up messages between sessions.

## Verification Checklist

Before submitting an ACP implementation:

- [ ] **Initialization works** - Client and agent successfully negotiate protocol version and capabilities
- [ ] **Capabilities are checked** - Code verifies capabilities before calling optional methods
- [ ] **Session creation works** - `session/new` returns a valid `sessionId`
- [ ] **Prompts are sent and received** - `session/prompt` sends user message, agent responds with `session/update` notifications
- [ ] **Tool calls are reported** - Agent sends `tool_call` updates with status transitions (pending → in_progress → completed)
- [ ] **Permissions are requested** - Agent calls `session/request_permission` and client responds with user choice
- [ ] **Cancellation works** - `session/cancel` notification stops execution and agent responds with `stopReason: "cancelled"`
- [ ] **File paths are absolute** - All paths in requests/responses use absolute paths
- [ ] **JSON-RPC format is valid** - All messages are valid JSON-RPC 2.0 (check `id`, `method`, `params`, `result`, `error`)
- [ ] **Notifications are one-way** - `session/update`, `session/cancel`, `elicitation/complete` have no `id` and receive no response
- [ ] **Error handling works** - Errors return JSON-RPC error objects with `code` and `message`
- [ ] **Version negotiation is correct** - Both sides agree on protocol version and follow its spec
- [ ] **Authentication flow matches advertised method** - If `type: "terminal"`, don't call `authenticate`; if `type: "agent"` (default), do call it
- [ ] **Session lifecycle is correct** - Sessions are created, used, and cleaned up properly
- [ ] **Concurrent sessions work** - Multiple sessions can run simultaneously without interference
- [ ] **Transport is correct** - Messages are properly delimited (newlines for stdio) and UTF-8 encoded

## Resources

**Comprehensive navigation:** https://agentclientprotocol.com/llms.txt

**Critical documentation pages:**
- [Protocol v1 Overview](https://agentclientprotocol.com/protocol/v1/overview) - Core concepts and message flow
- [Initialization](https://agentclientprotocol.com/protocol/v1/initialization) - Capability negotiation and version selection
- [Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup) - Creating, loading, and resuming sessions
- [Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) - Complete conversation lifecycle
- [Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls) - Reporting and managing tool execution
- [Authentication](https://agentclientprotocol.com/protocol/v1/authentication) - Auth flows and logout
- [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility) - Custom capabilities and methods
- [Schema](https://agentclientprotocol.com/protocol/v1/schema) - Complete JSON-RPC type definitions

**SDK libraries:**
- [TypeScript SDK](https://agentclientprotocol.com/libraries/typescript) - npm package with examples
- [Python SDK](https://agentclientprotocol.com/libraries/python)
- [Rust SDK](https://agentclientprotocol.com/libraries/rust)
- [Kotlin SDK](https://agentclientprotocol.com/libraries/kotlin)
- [Java SDK](https://agentclientprotocol.com/libraries/java)

---

> For additional documentation and navigation, see: https://agentclientprotocol.com/llms.txt