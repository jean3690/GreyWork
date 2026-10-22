# Plugin Authoring

GreyWork plugins extend the shell without shipping executable code into the renderer. A plugin is a
JSON package plus, optionally, one pinned ES module that runs in a **Web Worker**.

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
  "window": { "width": 200, "height": 200 }, // optional; needs requires: window.floating + worker+render

  "contributes": {
    "modes": [/* 1-8 full-page modes */],
    "uiRegions": [/* optional persistent regions, worker+render only */],
  },
}
```

Validation lives in `crates/greywork-host/src/services/plugin_market/package.rs` (`validate_package`); a package that
fails it is rejected before it touches disk. Key bounds: `entry` must be an allowed GitHub HTTPS host,
`sha256` lowercase hex, render `fps` 1-60, canvas 1-512 px, `uiRegions` titles 1-80 chars, region
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

| Capability          | Danger | Declared as                                                                                                                         | Notes                                                                                                                                                                    |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `net.fetch`         | medium | `{ "capability": "net.fetch", "hosts": ["api.github.com"], "methods": ["GET","POST"], "paths": ["/graphql"], "maxBytes": 4194304 }` | HTTPS requests; `GET`/`HEAD` by default, opt-in `POST` limited to declared path templates; 30 calls/min; 1 MiB per request/response by default (≤8 MiB)                  |
| `storage.kv`        | low    | `"storage.kv"`                                                                                                                      | Plugin-scoped KV: `get`/`set`/`remove`/`list`/`clear`, any JSON value, 256 KiB per plugin / 64 KiB per value                                                             |
| `fs.scoped`         | medium | `"fs.scoped"`                                                                                                                       | Plugin-private file area: `read`/`write`/`remove`/`list`/`stat`, relative paths only, symlinks refused, 1 MiB per file / 8 MiB per plugin                                |
| `workspace.read`    | high   | `"workspace.read"`                                                                                                                  | Read-only access to user-authorized workspace roots: `roots` lists them, `read` previews text files (≤256 KiB, truncated; binary/dirs refused); desktop/server host only |
| `llm.chat`          | high   | `{ "capability": "llm.chat", "models": ["gpt-4o-mini"] }`                                                                           | One-shot completion (`prompt`, optional `system`/`model`); credentials stay host-side, the host resolves the configured provider; 8 KiB prompt, 20 calls/10 min          |
| `artifacts.publish` | medium | `"artifacts.publish"`                                                                                                               | Publish text artifacts (`md`/`html`/`csv`) into the artifact panel; ≤256 KiB, 20 calls/10 min; HTML renders without scripts                                              |
| `notify`            | low    | `"notify"`                                                                                                                          | System notification `{ title, body }`; title gets a `[plugin-id] ` attribution prefix, 10 calls/min, desktop host only                                                   |
| `schedule`          | low    | `{ "capability": "schedule", "schedule": { "kind": "interval", "min": 5 } }`                                                        | Host-driven background wakeups: fires `registerSchedule` while a mount surface is alive, 5-1440 min interval, catch-up once on reactivation                              |
| `window.floating`   | medium | `"window.floating"`                                                                                                                 | Host-managed transparent always-on-top window rendering the render loop                                                                                                  |
| `plugin-admin`      | high   | `"plugin-admin"`                                                                                                                    | Host trust mark for built-ins; not callable from plugin code                                                                                                             |

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

## Publishing to the market

1. Add `packages/<id>.json` (and, for worker plugins, `<id>.js`).
2. Add a registry entry to `plugin-market/registry.json` with the GitHub `downloadUrl` and the
   package's `sha256` (`sha256sum packages/<id>.json`).
3. Sign the registry: `python3 plugin-market/sign_registry.py` (then `--verify` to double-check).
   The signature is mandatory for the official registry — see `plugin-market/README.md`.
4. Commit and push. The desktop app fetches the registry, verifies the signature, and verifies each
   package's SHA-256 on download.

Worker `runtime.entry` must point at a **pinned commit** (not a branch) so the SHA-256 stays stable.

## Local development

- Built-in plugins live in `packages/workbench/src/plugins/builtin.ts` and are trusted (their
  `requires` are auto-satisfied).
- Install-time validation is covered by `shipped_market_packages_pass_validation` in
  `plugin_market.rs`, so a bad package fails `cargo test` before release.
- Templates to copy from: `plugin-market/templates/`.
