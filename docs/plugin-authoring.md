# Plugin Authoring

GreyWork plugins extend the shell without shipping executable code into the renderer. A plugin is a
JSON package plus, optionally, one pinned ES module that runs in a **Web Worker**.

Type definitions for everything below live in [`@greywork/plugin-types`](../packages/plugin-types/README.md)
(manifest, the `greywork` worker global, render instructions and capability signatures). The package is
types-only and has no runtime; it is the fastest way to type-check a plugin before installing it.

Two kinds exist:

| Kind          | Package contents                            | Can execute code | Can call host capabilities |
| ------------- | ------------------------------------------- | ---------------- | -------------------------- |
| `declarative` | restricted JSON only                        | no               | no                         |
| `worker`      | JSON + one `runtime.entry` module (SHA-256) | yes (worker)     | yes, if granted            |

## Package shape

A package file is a `PluginPackage`:

```jsonc
{
  "schemaVersion": 1,
  "manifest": {/* MarketPluginManifest */},
  // "code" is injected by the host at install time — never ship it in the package file.
}
```

### Manifest reference

```jsonc
{
  "id": "demo.pet", // lowercase [a-z0-9._-], <=96 chars, unique; `core.` is reserved
  "name": "桌面宠物 · 猫", // 1-120 chars
  "version": "1.3.0", // x.y.z
  "description": "…", // optional
  "kind": "worker", // "declarative" (default) | "worker"

  "runtime": {
    // required for worker, forbidden for declarative
    "type": "worker",
    "entry": "https://raw.githubusercontent.com/<owner>/<repo>/<commit>/<file>.js",
    "sha256": "<64 lowercase hex>",
    "render": { "handler": "draw", "fps": 12, "width": 160, "height": 140, "pointer": true }, // optional render loop; "pointer": true enables pointer events
  },

  "requires": ["window.floating"], // capability declarations (plain string, or object with params — see Capabilities)
  // optional; needs requires: window.floating + worker+render. v2 fields (title / alwaysOnTop /
  // opacity / multiple) are optional and only change the window's shape.
  "window": { "width": 200, "height": 200, "title": "桌面宠物", "alwaysOnTop": true, "opacity": 0.9, "multiple": false },

  "contributes": {
    "modes": [/* 1-8 full-page modes */],
    "uiRegions": [/* optional persistent regions, worker+render only */],
  },
}
```

Validation lives in `crates/greywork-host/src/services/plugin_market/package.rs` (`validate_package`); a package that
fails it is rejected before it touches disk. Key bounds: `entry` must be an allowed GitHub HTTPS host,
`sha256` lowercase hex, render `fps` 1-60, canvas 1-512 px, window size 1-512 px, window title
≤64 chars (no control characters), window opacity 0.2-1, `uiRegions` titles 1-80 chars, region
action labels ≤20 chars, mode titles ≤120, headings ≤160, eyebrow ≤120, body ≤16 KiB.

### Modes

Each mode becomes a page at `/plugin/<modeId>` and a sidebar entry:

```jsonc
{
  "id": "demo-pet",
  "title": "宠物猫",
  "icon": "magic",
  "page": {
    "eyebrow": "…",
    "heading": "…",
    "body": "…",
    "fields": [{ "key": "satiety", "label": "饱食", "kind": "number", "default": 80, "min": 0, "max": 100, "step": 1 }],
    "outputs": [{ "label": "饱食", "valueKey": "satiety", "suffix": "/100" }],
    "actions": [{ "id": "feed", "label": "喂食", "style": "primary", "operation": { "type": "invoke", "handler": "feed" } }],
  },
}
```

Field kinds: `text` / `number` / `toggle`. Operations: `increment` / `set` / `reset` / `invoke`.
`invoke` is only legal for `worker` packages and dispatches to a worker handler. Field state is
persisted per `pluginId/modeId`.

### UI regions (worker only)

Attach a render loop to an existing shell region — `shellSidebar`, `activityPanel`, or
`workspaceOverlay`:

```jsonc
{
  "region": "workspaceOverlay",
  "id": "pet.overlay",
  "title": "宠物",
  "order": 5,
  "width": 160,
  "height": 150,
  "actions": [{ "id": "feed", "label": "喂食" }],
}
```

Region actions call the worker handler with the region's own persisted state and merge the returned
patch. A region is also the **mount surface** for `schedule`: while it is mounted, declared wakeups
fire (see [Scheduled wakeups](#scheduled-wakeups)).

## Capabilities

Capabilities are **granted per plugin**: authorizing `net.fetch` for plugin A never authorizes it for
plugin B. A plugin only gets a capability if it is (1) declared in `requires`, (2) authorized by the
user, and (3) registered in the host catalog (`packages/workbench/src/plugins/capabilities.ts`).

| Capability          | Danger | Declared as                                                                                                                         | Notes                                                                                                                                                                                                                     |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `net.fetch`         | medium | `{ "capability": "net.fetch", "hosts": ["api.github.com"], "methods": ["GET","POST"], "paths": ["/graphql"], "maxBytes": 4194304 }` | HTTPS requests; `GET`/`HEAD` by default, opt-in `POST` limited to declared path templates; 30 calls/min; 1 MiB per request/response by default (≤8 MiB)                                                                   |
| `storage.kv`        | low    | `"storage.kv"`                                                                                                                      | Plugin-scoped KV: `get`/`set`/`remove`/`list`/`clear`, any JSON value, 256 KiB per plugin / 64 KiB per value                                                                                                              |
| `fs.scoped`         | medium | `"fs.scoped"`                                                                                                                       | Plugin-private file area: `read`/`write`/`remove`/`list`/`stat`, relative paths only, symlinks refused, 1 MiB per file / 8 MiB per plugin                                                                                 |
| `workspace.read`    | high   | `"workspace.read"`                                                                                                                  | Read-only access to user-authorized workspace roots: `roots` lists them, `read` previews text files (≤256 KiB, truncated; binary/dirs refused); desktop/server host only                                                  |
| `llm.chat`          | high   | `{ "capability": "llm.chat", "models": ["gpt-4o-mini"] }`                                                                           | One-shot completion (`prompt`, optional `system`/`model`); credentials stay host-side, the host resolves the configured provider; 8 KiB prompt, 20 calls/10 min                                                           |
| `mcp.connect`       | high   | `{ "capability": "mcp.connect", "servers": [{ "name": "fs", "tools": ["read_file"] }] }`                                            | Call tools on **MCP servers the user already configured in Settings**, referenced by name; 1-4 servers, 1-16 tools each; http + stdio only (sse stays agent-only); ≤16 KiB arguments, 30 calls/min, 30s timeout (60s cap) |
| `artifacts.publish` | medium | `"artifacts.publish"`                                                                                                               | Publish text artifacts (`md`/`html`/`csv`) into the artifact panel; ≤256 KiB, 20 calls/10 min; HTML renders without scripts                                                                                               |
| `clipboard`         | medium | `"clipboard"` (write) / `{ "capability": "clipboard", "ops": ["read","write"] }`                                                    | Read/write the system clipboard; **read is denied by default** and must be declared via `ops`; ≤64 KiB per call, 20 calls/min, reads audited by length only                                                               |
| `notify`            | low    | `"notify"`                                                                                                                          | System notification `{ title, body }`; title gets a `[plugin-id] ` attribution prefix, 10 calls/min, desktop host only                                                                                                    |
| `schedule`          | low    | `{ "capability": "schedule", "schedule": { "kind": "interval", "min": 5 } }`                                                        | Host-driven background wakeups: fires `registerSchedule` while a mount surface is alive, 5-1440 min interval, catch-up once on reactivation                                                                               |
| `window.floating`   | medium | `"window.floating"`                                                                                                                 | Host-managed transparent window rendering the render loop; title / always-on-top / opacity / instances come from the `window` block (see Floating windows)                                                                |
| `plugin-admin`      | high   | `"plugin-admin"`                                                                                                                    | Host trust mark for built-ins; not callable from plugin code                                                                                                                                                              |

`requires` is also the activation gate: enabling a plugin whose grants are missing fails with a
`CapabilityRequiredError`, and the plugin center surfaces which capability still needs authorizing.

## Worker API

The worker prelude exposes exactly one global, `greywork`:

```js
// Register an action handler: (state) => patch | void
greywork.registerAction("feed", (state) => ({ satiety: Math.min(100, state.satiety + 20) }));

// Register a render handler: (state) => RenderCommand[]
greywork.registerAction("draw", (state) => [{ kind: "circle", cx: 80, cy: 70, r: 30, fill: "#f4a" }]);

// Call a host capability (only those declared + granted)
const res = await greywork.call("net.fetch", { url: "https://api.github.com/meta" });

// Plugin-scoped KV storage (JSON values, isolated per plugin, 256 KiB quota)
await greywork.call("storage.kv", { op: "set", key: "note", value: { text: "hi", at: Date.now() } });
const { value } = await greywork.call("storage.kv", { op: "get", key: "note" });

// Plugin-private sandbox files (relative paths; 1 MiB/file, 8 MiB per plugin; desktop/server host only)
await greywork.call("fs.scoped", { op: "write", path: "logs/today.txt", data: "hi" });
const { exists, data } = await greywork.call("fs.scoped", { op: "read", path: "logs/today.txt" });

// User-authorized workspace, read-only (same allowlist as the file tree; 256 KiB preview cap; desktop/server host only)
const { roots } = await greywork.call("workspace.read", { op: "roots" });
const file = await greywork.call("workspace.read", { op: "read", path: "README.md" });
// → { exists, path, name, data, bytes, truncated }

// One-shot model completion (model must be allowlisted in the manifest; credentials stay host-side)
const { text } = await greywork.call("llm.chat", { prompt: "Summarize: …", system: "Be terse." });

// MCP tool call: the server must be configured in Settings and named in the manifest;
// connection params and credentials stay host-side, the plugin only names server + tool
const { text, isError } = await greywork.call("mcp.connect", {
  server: "fs",
  tool: "read_file",
  arguments: { path: "README.md" },
});

// Clipboard: writing is allowed by the plain grant, reading needs ops: ["read"]
await greywork.call("clipboard", { op: "write", text: "copied by the plugin" });
const { text } = await greywork.call("clipboard", { op: "read" });

// Publish a text artifact into the artifact panel (md/html/csv, ≤256 KiB; opens a preview tab)
await greywork.call("artifacts.publish", { name: "weekly-report", format: "md", data: "# Report…" });

// System notification (title is prefixed `[plugin-id]` by the host; 10 calls/min; desktop host only)
await greywork.call("notify", { title: "构建完成", body: "所有测试通过" });

// Background wakeup: host calls this while a mount surface is alive (declared via `schedule`)
greywork.registerSchedule((state) => ({ ticks: (typeof state.ticks === "number" ? state.ticks : 0) + 1 }));

// Pointer events: only called when the manifest declares `render.pointer` (see Pointer events)
greywork.registerPointer((event, state) => ({ x: event.x, y: event.y, last: event.type }));
```

- Action handlers return a **patch** of primitive values (`string | number | boolean`); the host
  validates it (`isPatch`) and merges it into the persisted state. Anything else is rejected.
- `greywork.call` is the only route to host resources. Every call is re-checked against the
  declaration, the plugin's grants, and the catalog; revoking a grant takes effect on the next call.
- Actions time out after 10 s, host calls after 20 s.
- There is no DOM, no `window`, no network: a worker that wants I/O must go through `greywork.call`.

### Network requests

`net.fetch` is the only network path. Requests default to `GET`/`HEAD`; `POST` is opt-in and can only
reach paths you declare as templates.

```jsonc
"requires": [{
  "capability": "net.fetch",
  "hosts": ["api.github.com"],
  "methods": ["GET", "POST"],
  "paths": ["/graphql", "/repos/*/issues"],
  "maxBytes": 4194304
}]
```

```js
const res = await greywork.call("net.fetch", {
  url: "https://api.github.com/graphql",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "{ viewer { login } }" }),
});
```

- `hosts` (required, 1-16 entries): HTTPS only, exact host or `.`-bounded subdomain match.
- `methods` (optional): a subset of `GET`/`HEAD`/`POST`; omitting it means `GET`/`HEAD`.
- `paths` (required when `POST` is declared, 1-8 entries): templates matched against the URL path.
  `*` matches within one segment, `**` matches across segments (e.g. `/v1/**`). `GET`/`HEAD` are
  host-scoped only.
- `maxBytes` (optional, 1 KiB-8 MiB): per-request request/response byte cap; defaults to 1 MiB.
- `body` is only allowed on `POST` and must fit within `maxBytes`.
- The rate limit stays at 30 calls/min per plugin regardless of the declaration, and every call is
  audited. The desktop/server host re-checks host/method/path/bytes independently (defense in depth).

### Model calls

`llm.chat` is the only way for a plugin to reach a model. The plugin sends a prompt, never a key:
at call time the host resolves the user's configured provider (base URL + API-key environment variable
name) and runs a single non-streaming completion.

```jsonc
"requires": [{ "capability": "llm.chat", "models": ["gpt-4o-mini", "qwen2.5:7b"] }]
```

```js
const { text, model } = await greywork.call("llm.chat", {
  prompt: "Summarize this changelog in one sentence.",
  system: "Answer in one sentence.",
});
```

- `models` (required, 1-8 entries): allowlist. Any other model id is refused before the host is
  called; a manifest that declares `"llm.chat"` as a plain string is rejected at install time.
- `prompt` (required, ≤8000 chars), `system` (optional, ≤2000 chars), `model` (optional; defaults
  to the first allowlisted id).
- Credentials never reach the plugin, and neither the base URL nor the key variable can be overridden
  from plugin code.
- 20 calls per 10 minutes per plugin, every call audited (`ok` / `denied` / `error`).
- No host (web preview) means the call fails with a `denied` audit entry, same as `workspace.read`.

### MCP tools

`mcp.connect` lets a plugin call tools on an **MCP server the user already configured** (Settings →
MCP). The manifest names the server and the exact tools; everything connection-shaped (URL, command,
env, auth headers) is read from the user's settings by the host and never enters the worker.

```jsonc
"requires": [
  { "capability": "mcp.connect", "servers": [{ "name": "fs", "tools": ["read_file", "list_dir"] }] }
]
```

```js
const { text, isError } = await greywork.call("mcp.connect", {
  server: "fs",
  tool: "read_file",
  arguments: { path: "README.md" },
});
```

- `servers` (required, 1-4 entries): each `{ name, tools }`, where `name` must equal the server name
  in Settings. `tools` is mandatory (1-16 entries) — an empty list means "no tools", so there is no
  way to ask for "everything on this server". The plain string form `"mcp.connect"` is rejected at
  install time.
- `arguments` must be a JSON object (≤16 KiB serialized). The host returns **text only** — image /
  base64 content blocks are dropped so a single call cannot flood the worker.
- Transports: `http` and `stdio`. `sse` servers can be declared for the agent to connect to, but
  they are not proxied for plugins.
- 30 calls per minute per plugin, 30s timeout (clamped to 60s), and the host re-checks the tool
  allowlist independently of the renderer — the settings-backed grant is the first gate, not the only one.
- A server that is disabled or renamed in Settings makes the call fail with a clear error; the plugin
  has no way to fall back to another server.

### Publishing artifacts

`artifacts.publish` puts a text result into the artifact panel (the same list the agent's own outputs
land in), so the user can preview it, download it, or open it in their file manager.

```js
const { id, path } = await greywork.call("artifacts.publish", {
  name: "weekly-report",
  format: "md", // "md" | "html" | "csv"
  data: "# Weekly report\n…",
});
```

- `data` is capped at 256 KiB per artifact; empty payloads and unknown formats are rejected before
  anything is written.
- The plugin only supplies a display name: the host sanitizes it and writes under
  `plugins/<plugin-id>/` in the virtual file system, then mirrors it into the workspace
  `artifacts/` directory (desktop/server host) like any other artifact.
- HTML is rendered by the artifact viewer in a sandbox **without** `allow-scripts`, so published
  markup cannot run code.
- 20 calls per 10 minutes per plugin; each call is audited and opens a preview tab, which is why the
  rate limit is tighter than the size cap would suggest.

### Clipboard

`clipboard` is the one capability whose default is **asymmetric**: writing is allowed, reading is not.

```jsonc
// write-only (the plain string form)
"requires": ["clipboard"]

// explicit read (and write) — required to read what the user copied
"requires": [{ "capability": "clipboard", "ops": ["read", "write"] }]
```

```js
await greywork.call("clipboard", { op: "write", text: "generated snippet" });
const { text, truncated } = await greywork.call("clipboard", { op: "read" });
```

- Reading is a privacy surface: it must be declared through `ops`, and the authorization dialog shows
  it as such. A plugin that only declares the plain string gets `write` and is refused on `read`.
- 64 KiB per call in both directions; longer reads come back truncated with `truncated: true`.
- 20 calls per minute per plugin (writes overwrite what the user is holding, so the limit is tight).
- Audit entries record the **length only** — clipboard contents never reach the audit log.
- The host bridge picks the reliable path per runtime (Electron main process, Web API in a real
  browser); in the browser a read may be refused without a user gesture, which surfaces as an error.

### Chaining capabilities

One action can call several capabilities in sequence; each call is authorized on its own, so a missing
grant fails that step only. `packages/workbench/tests/unit/plugins/fixtures/demo.brief.js` is the
reference chain:
`workspace.read` (the README of an authorized root) → `llm.chat` (three-line summary) →
`artifacts.publish` (Markdown artifact) → `clipboard` (the summary).

- Wrap each step in its own `try/catch` and stop on failure — work already done (a published artifact,
  a copied summary) survives a later step being denied.
- Record a short step trail in a text field (`✓ read file · ✗ model summary`) so the user can see
  where the chain stopped instead of a single opaque error.
- Truncate before spending: the excerpt sent to the model is capped well under the 8 KiB prompt limit,
  and the artifact carries the same excerpt rather than the whole file.

### Scheduled wakeups

`schedule` is **host-driven**: the plugin doesn't call it, it declares an interval and registers a
handler. The host (the workbench renderer, which owns the worker) keeps a clock while the plugin's
mount surface is alive and calls the handler through the same `invoke` channel as an action — the
returned patch is merged into the surface's state exactly like an action patch.

```jsonc
"requires": [{ "capability": "schedule", "schedule": { "kind": "interval", "min": 15 } }]
```

```js
greywork.registerSchedule(async (state) => ({ ticks: (state.ticks ?? 0) + 1, at: Date.now() }));
```

- Interval `min` is 5-1440 minutes (checked at install time). `"schedule"` is a reserved handler
  name — `registerAction("schedule", …)` is rejected.
- Fires **only while a `uiRegion` is mounted**; when the surface is out of memory (e.g. disabled)
  wakeups are skipped, and the next activation catches up **once** before resuming the cadence.
- Works in the browser preview too — unlike `notify`/`fs.scoped`, the scheduler lives in the
  workbench, so it needs no desktop/server host. The `effectiveRegionSchedule` gate means an
  unauthorized or undeclared plugin never gets a clock.

### Command palette entries

`contributes.commands` puts a package's entry points into the global **⌘K / Ctrl+K** search (the
titlebar search panel). Entries are grouped as "Plugin commands" and land on the package's own page.

```jsonc
"contributes": {
  "modes": [/* … */],
  "commands": [
    { "id": "feed", "title": "给猫喂食", "description": "宠物插件 · 饱食 +20", "mode": "demo-pet" }
  ]
}
```

- 1-16 entries per package. `id` must be a key (letters / digits / `._-`), **globally unique**:
  the palette is one flat list, so a second package claiming the same id is rejected at registration
  time (`ContributionConflictError`); ids also have to be unique inside one package.
- `title` is 1-60 chars, `description` ≤120, neither may contain control characters.
- `mode` must name one of the package's own modes (defaults to the first one). A command whose page
  does not exist is rejected at install time instead of failing with a blank route later.
- **Navigation only.** There is deliberately no `handler`: the palette can be opened from any page,
  where the package's worker is not mounted yet, and running plugin code from the palette would be a
  standing execution surface. Plugin logic stays behind the page the command opens.
- Entries disappear immediately when the plugin is disabled or uninstalled (the palette reads the
  same seam snapshot as the sidebar), so there is no separate cleanup path.

### Settings schema

`contributes.settingsSchema` puts a package's configuration into Settings → **插件配置**. Fields use
the exact same shape as page fields (`key` / `label` / `kind` / `default` / bounds), so there is one
schema to learn.

```jsonc
"contributes": {
  "settingsSchema": [
    { "key": "api_base", "label": "接口地址", "kind": "text", "default": "https://example.com", "maxLength": 200 },
    { "key": "interval", "label": "轮询间隔（分钟）", "kind": "number", "default": 15, "min": 5, "max": 60, "step": 5 },
    { "key": "enabled", "label": "启用", "kind": "toggle", "default": true }
  ]
}
```

- Kinds: `text` / `number` / `toggle`; up to 16 fields, keys unique, `default` must match the kind.
- **Values live in the plugin's own `storage.kv` namespace, keyed by the field key.** Read them at
  runtime with `greywork.call("storage.kv", { op: "get", key: "interval" })` — no second store, no
  copy that can drift from what the plugin writes itself.
- The pane only lists **enabled** packages; disabling a plugin takes its form away (values stay in KV).
- Writes go through the same JSON-safety and quota checks as the capability (64 KiB per value, 256 KiB
  per plugin); a rejected write shows the reason in the pane instead of silently dropping the edit.

### Context menu entries

`contributes.contextMenu` adds "open with plugin" items to the host's own right-click menus. Like
palette commands they only navigate to the package's page; they never run plugin code.

```jsonc
"contributes": {
  "modes": [/* … */],
  "contextMenu": [
    { "id": "open-in-pet", "label": "在宠物里打开", "targets": ["fileTree", "preview"], "mode": "demo-pet" }
  ]
}
```

- `targets` picks where the item shows up: `fileTree`, `preview`, `conversation` (1-3 entries, no
  duplicates). Unknown areas are rejected at install time so a package never claims a surface the
  host does not have.
- 1-8 entries per package; `id` is global (a second package claiming it is rejected at registration
  time, same as palette commands), `label` is 1-40 chars without control characters.
- `mode` must name one of the package's modes (defaults to the first).
- Items appear under a "插件" group after the host's own entries — no host item is ever hidden, and
  when a package contributes nothing to a surface the menu is byte-for-byte the old one.

### Status bar

`contributes.statusBar` adds persistent entries to a thin bar at the bottom of the shell —
"last sync 10:24" style.

```jsonc
"contributes": {
  "statusBar": [{ "id": "sync", "label": "上次成功 10:24", "mode": "demo-pet" }]
}
```

- 1-8 entries per package; `id` is globally unique (it doubles as the addressing key for
  `setStatus`); `label` is 1-60 chars; `mode` must be one of the package's modes (defaults to the
  first) and is where a click lands.
- A worker updates the text at runtime with `greywork.setStatus("sync", "同步中…")`. The host keeps
  the **last** text per entry (control characters become spaces, capped at 80 chars), survives the
  plugin page being closed, and falls back to the manifest label when nothing was ever set.
- The id must be declared in the manifest — updates to undeclared ids are dropped, so a package can
  never write into another package's entry.
- The bar only shows **active** packages; disabling one removes its entries until re-enabled.

### Keyboard shortcuts

`contributes.keybindings` binds a global key to "open this package's page". Same navigation-only
trade-off as palette commands and context-menu entries.

```jsonc
"contributes": {
  "keybindings": [
    { "id": "open", "key": "mod+shift+p", "mode": "demo-pet" }
  ]
}
```

- `key` is written as modifiers + one base key: modifiers are `mod` (Cmd on macOS, Ctrl elsewhere),
  `ctrl`, `alt`, `shift` — in that order, and at least one of `mod` / `ctrl` / `alt` is required
  (plain `shift+letter` would type into whatever has focus). The base key is a lowercase letter, a
  digit, or `F1`-`F12` (function keys may be used bare, e.g. `f9`). Letters are case-insensitive.
- 1-8 entries per package; `id` is unique inside the package; the same **combination** may only be
  claimed once across all packages (a later registration is rejected at registration time).
- Host shortcuts always win: a plugin key that collides with a host shortcut simply never fires.
  Reserved today: mod+n, mod+b, mod+e, mod+backslash, mod+backquote and mod+1 through mod+4.
- The navigation-only rule is the same as every other contribution surface: a shortcut opens the
  package's page, it does not run plugin code.

### Floating windows

A worker plugin that declares `window.floating` **and** a `window` block can be popped out of the
workbench into an OS-level window (the pet in the demo packages). The host creates and owns that
window; the plugin still has no handle to it — it only supplies the render loop.

```jsonc
"requires": ["window.floating"],
"window": {
  "width": 200,
  "height": 200,
  "title": "桌面宠物",   // optional, ≤64 chars; falls back to manifest.name
  "alwaysOnTop": true,  // optional, default true
  "opacity": 0.9,       // optional, 0.2-1, default 1
  "multiple": false     // optional, default false; up to 4 instances
}
```

- **Position is remembered per window**: the host stores the last bounds in
  `plugin-window-bounds.json` and pulls them back onto a visible display on reopen (unplugging a
  monitor cannot strand the window off-screen). Size still comes from the declaration.
- **Pin** is a button in the window's own header: it toggles always-on-top at runtime through the
  host (the toggle targets _that_ window, so multiple instances never affect each other).
- **Multiple instances**: with `multiple: true` each "pop out" opens the next free instance
  (`plugin-window-<id>::2`, …) up to **4**; once full, the last window is focused instead. Disabling
  or uninstalling the plugin closes **all** of its windows.
- The window content is the same sandboxed worker + render-command pipeline as the in-app region —
  no DOM, no extra privileges. `opacity` only affects the transparent shell, not the canvas bounds.

### Render commands

The render handler returns a JSON array of whitelisted commands, validated by
`packages/workbench/src/plugins/render-commands.ts`:

`circle` · `ellipse` · `rect` · `path` · `text` · `group` (with `translate` / `rotate` / `scale`),
each with optional `fill` / `stroke` / `strokeWidth` / `opacity`.

An invalid frame is dropped entirely (the previous frame stays on screen). Bounds: 256 commands per
frame, coordinates within ±1024, text ≤64 chars, path data ≤1024 chars from the SVG path alphabet,
colors limited to `#hex` / `rgb()` / `rgba()` / plain names.

### Pointer events

Rendering is otherwise one-way. Declare `"pointer": true` inside `runtime.render` to turn the canvas
into an input surface: the host listens for `pointerdown` / `pointermove` / `pointerup` /
`pointercancel` / `pointerleave` on the canvas and forwards each one to the worker's pointer handler
through the same `invoke`-style channel as an action.

```jsonc
"runtime": {
  "type": "worker",
  "entry": "https://raw.githubusercontent.com/<owner>/<repo>/<commit>/demo.js",
  "sha256": "<64 lowercase hex>",
  "render": { "handler": "draw", "fps": 12, "width": 220, "height": 160, "pointer": true }
}
```

```js
greywork.registerPointer((event, state) => {
  // event = { type, x, y, nx, ny, buttons, pointerId }
  if (event.type === "down") return { x: event.x, y: event.y, clicks: (state.clicks ?? 0) + 1 };
  return { x: event.x, y: event.y };
});
```

- The host builds the event, not the worker: `x`/`y` are **canvas coordinates clamped to
  `[0, width]` / `[0, height]`**, `nx`/`ny` are the `[0,1]` normalized equivalents, `type` is one of
  five fixed values, `buttons`/`pointerId` are integers. Worker code still has no DOM.
- The handler returns a **state patch** exactly like an action (`isPatch` — primitives only); the
  host merges it into the same state that drives the render loop, so the next frame reflects it.
- Dispatch is serialized (one event in flight): `move` events are coalesced, discrete
  events (`down`/`up`/`cancel`/`leave`) are delivered in order. A handler that throws or times out
  drops that event without stopping the loop.
- `"pointer"` is a reserved handler name — `registerAction("pointer", …)` is rejected.
- Pointer events are **gated by the declaration only**: they carry input, not host resources, so no
  capability grant is involved. `render.pointer` defaults to `false` (existing packages unaffected).

## Shipping a plugin

The in-app remote plugin market has been retired — there is no registry URL, catalog browsing, or
install/uninstall UI any more. Plugins reach the shell in one of two ways:

1. **Built-in** — registered from `packages/workbench/src/plugins/builtin.ts`; trusted, their
   `requires` are auto-satisfied.
2. **Already installed** — the host scans `<dataDir>/plugins/<id>/plugin.json` at boot and registers
   whatever it finds. Deploy packages there out-of-band (for example with your own installer).

The reference worker implementations live in `packages/workbench/tests/unit/plugins/fixtures/`
(`demo.brief.js`, `demo.wallpaper.js`); there is no longer a sample package tree or registry
signing script in this repo.

Worker `runtime.entry` should still point at a **pinned commit** (not a branch) so the SHA-256 stays
stable.
