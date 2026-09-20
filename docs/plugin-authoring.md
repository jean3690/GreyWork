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
  "manifest": {
    /* MarketPluginManifest */
  },
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
    "render": { "handler": "draw", "fps": 12, "width": 160, "height": 140 }, // optional render loop
  },

  "requires": ["window.floating"], // capability declarations (see below)
  "window": { "width": 200, "height": 200 }, // optional; needs requires: window.floating + worker+render

  "contributes": {
    "modes": [
      /* 1-8 full-page modes */
    ],
    "uiRegions": [
      /* optional persistent regions, worker+render only */
    ],
  },
}
```

Validation lives in `apps/desktop/src-tauri/src/plugin_market.rs` (`validate_package`); a package that
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
patch.

## Capabilities

Capabilities are **granted per plugin**: authorizing `net.fetch` for plugin A never authorizes it for
plugin B. A plugin only gets a capability if it is (1) declared in `requires`, (2) authorized by the
user, and (3) registered in the host catalog (`packages/workbench/src/plugins/capabilities.ts`).

| Capability        | Danger | Declared as                                                  | Notes                                                                   |
| ----------------- | ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `net.fetch`       | medium | `{ "capability": "net.fetch", "hosts": ["api.github.com"] }` | HTTPS GET/HEAD only, 30 calls/min, 1 MiB response cap, host allowlist   |
| `window.floating` | medium | `"window.floating"`                                          | Host-managed transparent always-on-top window rendering the render loop |
| `plugin-admin`    | high   | `"plugin-admin"`                                             | Host trust mark for built-ins; not callable from plugin code            |

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
```

- Action handlers return a **patch** of primitive values (`string | number | boolean`); the host
  validates it (`isPatch`) and merges it into the persisted state. Anything else is rejected.
- `greywork.call` is the only route to host resources. Every call is re-checked against the
  declaration, the plugin's grants, and the catalog; revoking a grant takes effect on the next call.
- Actions time out after 10 s, host calls after 20 s.
- There is no DOM, no `window`, no network: a worker that wants I/O must go through `greywork.call`.

### Render commands

The render handler returns a JSON array of whitelisted commands, validated by
`packages/workbench/src/plugins/render-commands.ts`:

`circle` · `ellipse` · `rect` · `path` · `text` · `group` (with `translate` / `rotate` / `scale`),
each with optional `fill` / `stroke` / `strokeWidth` / `opacity`.

An invalid frame is dropped entirely (the previous frame stays on screen). Bounds: 256 commands per
frame, coordinates within ±1024, text ≤64 chars, path data ≤1024 chars from the SVG path alphabet,
colors limited to `#hex` / `rgb()` / `rgba()` / plain names.

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
