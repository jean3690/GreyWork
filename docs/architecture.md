# GreyWork Architecture

GreyWork is a monorepo implementing a desktop-first AI agent application. It uses pnpm workspaces with TypeScript packages in `packages/` and a Tauri desktop shell in `apps/desktop/`, backed by Rust for the native host.

## Monorepo Layout

```
greyWork/
├── apps/
│   ├── desktop/              # Tauri shell: Vite + Vue renderer + thin Rust wrappers
│   └── server/               # Headless axum server: HTTP command endpoint + WS events + login
├── crates/
│   └── greywork-host/        # Shared domain logic (Tauri-free) used by both hosts
├── packages/
│   ├── core/                 # Shared types & math (no deps)
│   ├── editor/               # File system, Git, CodeMirror abstractions
│   ├── agents/               # Agent domain logic (roles, events, orchestration)
│   ├── llm/                  # LLM provider clients (OpenAI-compatible stream → IPC)
│   ├── acp/                  # Agent Client Protocol client (Tauri IPC + WebSocket)
│   ├── shell/                # Provider registry & transport data plane
│   ├── plugins/              # Plugin market source adapters + types
│   ├── cowork/               # Co-operative workspace engine
│   └── workbench/            # Shared UI package: shell, views, plugin runtime
├── plugin-market/            # Plugin registry source + signing
├── .agents/skills/           # Installed agent skills (vendored)
└── skills-lock.json          # Locked skill definitions with hashes
```

## Dependency Direction

The project enforces strict dependency direction: **leaf packages depend on nothing or only on `@greywork/core`**; higher-level packages depend on lower-level ones.

```
core        ← (nothing)
editor      ← core
agents      ← core
llm         ← core
shell       ← core
acp         ← core
cowork      ← core
plugins     ← core
workbench   ← agents, editor, llm, acp, shell, plugins, coop, core
desktop     ← workbench (+ Tauri Rust host)
```

**Key rules (enforced by ESLint):**

- `packages/agents/src/**` can only import from `@greywork/core` from within the `@greywork/*` scope — domain logic stays decoupled from other packages.
- No `packages/*` may import from `apps/*` (no reverse dependency).

### Package Descriptions

| Package               | Purpose                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@greywork/core`      | Shared TypeScript types (vectors, bounding boxes, version info) and math utilities (clamp, lerp, vector ops). Leaf-level.                                                                                                                                                                                                                    |
| `@greywork/editor`    | File system, Git, and CodeMirror abstractions. The memory-backed mocks ship for browser/unit contexts; the real Git host lives in `src/tauri.ts` (`createTauriGitService`) and talks to the Rust host's `git_*` IPC commands (see `apps/desktop/src-tauri/src/git.rs`), which run the git CLI strictly inside the authorized workspace root. |
| `@greywork/agents`    | AI agent domain: role definitions, state machine, event model, task orchestration pipeline.                                                                                                                                                                                                                                                  |
| `@greywork/llm`       | LLM provider clients using OpenAI-compatible streaming protocol. Bridges to Tauri IPC for the Rust `LlmHost` backend.                                                                                                                                                                                                                        |
| `@greywork/acp`       | Agent Client Protocol client — session transport (Tauri IPC and WebSocket), permission mapping, event model.                                                                                                                                                                                                                                 |
| `@greywork/shell`     | Provider registry and desktop communication data plane. Contains ACP agent backend presets and model provider enums.                                                                                                                                                                                                                         |
| `@greywork/plugins`   | Plugin market source adapters (skills.sh registry search/download) and AI command strategy types.                                                                                                                                                                                                                                            |
| `@greywork/cowork`    | Co-operative workspace engine for collaborative sessions.                                                                                                                                                                                                                                                                                    |
| `@greywork/workbench` | Complete shared UI package used by both desktop and web. Exports a single `GreyWorkWorkbench` entry point. Includes the plugin runtime (Cordis micro-kernel), router, stores, i18n, theme, and all views.                                                                                                                                    |

## Build & Package

- All packages use source-direct execution (TypeScript via Vite/vue-tsc), no separate build step for packages.
- The desktop app builds via Tauri: `pnpm build` runs `vue-tsc --noEmit && vite build` as `beforeBuildCommand`, then Tauri compiles the Rust binary.
- Domain logic lives in `crates/greywork-host/` (a single Cargo workspace at the repo root, one `Cargo.lock`), shared by both hosts. Major domains: `llm.rs` (OpenAI-compatible stream -> events), `acp_host.rs`, `mcp*.rs`, `host_exec.rs` (sandboxed process exec), `http.rs` / `web_fetch.rs`, `workspace_fs.rs` (authorized workspace root resolution) and `git.rs` (git CLI surfaced as `git_*` commands, scoped to the authorized root). The command face has a single source of truth: `commands::COMMANDS` + `commands::dispatch`.
- `apps/desktop/src-tauri/src/` keeps only `#[tauri::command]` wrappers and truly host-specific modules (`sys` / `tray` / `notify` / `close_guard` / `plugin_window` / `TauriHost`).
- `apps/server/` is the headless host (see below).
- Patches are applied to dependencies via `patches/` directory (e.g., `@univerjs/engine-render`, `exceljs`).

## Testing

- Each package with testable logic has a `tests/` directory using Vitest.
- `pnpm -r test` runs all tests across packages with coverage enabled where configured.
- Rust tests run via `cargo test --locked` from the **repo root** (single workspace: desktop shell + `greywork-host` + server).
- Coverage thresholds are configured per-package in `vitest.config.ts`.

## Headless Server (`apps/server`)

A single-user, self-hosted web host for GreyWork. It reuses **all** of `greywork-host`'s domain
logic and adds only the host shell: HTTP transport, WebSocket event delivery, built-in login, and
the server-side security policy. It never depends on `tauri`.

### Reuse boundary

The command face has one source of truth: `greywork_host::commands::COMMANDS` (metadata) and
`commands::dispatch(name, args, ctx)`. The desktop shell registers the same commands with Tauri's
`generate_handler!` (a drift test asserts the two name sets are identical); the server routes
`POST /api/command` into `dispatch`. Commands marked `desktop_only` (native pickers, tray, system
browser) are rejected server-side.

### Configuration

Loaded as `defaults → <data_dir>/server.json → GREYWORK_* env vars` (env wins). Fields: `bind`,
`data_dir`, `home_dir`, `session_ttl_secs`, `password_hash` / `password`, `agent_programs`,
`workspace_roots`, `sandbox`, `tier`, `secure_cookie`, `allowed_origins`, `static_dir`
(`GREYWORK_STATIC_DIR`, see [Static hosting](#static-hosting-spa)).

Password bootstrap, in priority order:

1. `GREYWORK_PASSWORD_HASH` — an argon2 PHC string.
2. `<data_dir>/auth.json` — written by `greywork-server set-password` (mode 0600).
3. `GREYWORK_PASSWORD` — plaintext, hashed in memory at startup (dev convenience).
4. Otherwise a random password is generated, written to `auth.json` (0600), and printed **once** to
   stderr.

`greywork-server hash-password` prints an argon2 PHC string from stdin.

### Authentication

Password → opaque session token, carried either as an `HttpOnly; SameSite=Strict` cookie
(`gw_session`) or as `Authorization: Bearer <token>` — the two are equivalent. Sessions live in an
in-memory table keyed by `SHA-256(token)` (the plaintext token is never stored), so a restart
invalidates every session. Wrong password, invalid token, and expired session all return the same
`401 {"error":"未认证"}`. Repeated login failures from one IP are throttled (5 failures → 60s
cooldown → `429`). CSRF rests on `SameSite=Strict` plus an optional `allowed_origins` allow-list.

### HTTP / WebSocket contract

| Method | Path            | Auth | Notes                                                    |
| ------ | --------------- | ---- | -------------------------------------------------------- |
| GET    | `/api/health`   | no   | `{status, version}`                                      |
| POST   | `/api/login`    | no   | `{password}` → `{token}` + `Set-Cookie`                  |
| POST   | `/api/logout`   | yes  | clears cookie + server session                           |
| GET    | `/api/session`  | yes  | `{authenticated, expiresAt}`                             |
| GET    | `/api/commands` | yes  | command metadata (`auth` / `desktopOnly` / `binary`)     |
| POST   | `/api/command`  | yes  | `{command, args}` → the command's return value, verbatim |
| GET    | `/api/events`   | yes  | WebSocket; frames are `{event, payload}`                 |

Successful `/api/command` responses carry the command's return value directly (JSON, or raw bytes
for the two `binary` commands with `Content-Type: application/octet-stream`). Failures are a
non-2xx status plus `{"error": "..."}`. Request bodies are capped at 32 MB (session snapshots and
base64 attachments exceed axum's 2 MB default). The WebSocket carries the same event names the
desktop renderer listens for (`acp://event`, `llm://event`, `automation://due`,
`<channel>://state` / `<channel>://inbound`, …); `notify` becomes a `host://notify` event. Events
are best-effort — a lagging subscriber skips old events, never replays them.

### Static hosting (SPA)

Set `GREYWORK_STATIC_DIR` (or `static_dir` in `server.json`) to the built frontend output
(`apps/desktop/dist`) and the server serves the UI from the same origin. Unset, the server is
API-only. The directory must contain `index.html`; if it doesn't, **startup fails hard** — the
container health probe hits `/api/health`, which stays green even while the UI 404s, so a warning
here would let a broken image ship as "healthy".

| Path          | Source                       | `Cache-Control`                              |
| ------------- | ---------------------------- | -------------------------------------------- |
| `/`           | `index.html`                 | `no-cache` (deploys take effect immediately) |
| `/assets/*`   | Vite content-hashed chunks   | `public, max-age=31536000, immutable`        |
| anything else | `pdfjs/`, `vscode-icons/`, … | `no-cache` (cacheable, must revalidate)      |
| unknown path  | —                            | plain `404`                                  |

Design notes:

- **No SPA catch-all.** The frontend uses hash routing (`createWebHashHistory`), so deep links
  resolve client-side and `/` is the only HTML route the server must serve. A catch-all would turn
  mistyped asset paths into `200` + `index.html`, polluting caches and hiding errors.
- **Static routes are unauthenticated by construction** — auth is a per-handler extractor and the
  static routes don't use it (the login page must load before login).
- **Compression only on the static sub-router** (`tower_http::CompressionLayer`, gzip/brotli).
  API responses — including 32 MB binary reads — are never compressed. This is why `tower-http`
  entered the dependency tree; CORS is still deliberately absent (same-origin deployment).
- **Cache-Control interaction.** The global `security_headers` middleware applies its `no-store`
  default via `or_insert`, so the per-path static cache policies above survive; `/api/*` responses
  set no cache header of their own and still get `no-store` — command results may contain file
  contents and credentials.

### Security model

The **authentication boundary is the security boundary**: a valid session can spawn agent
processes, so the controls below limit what the _web UI_ can be tricked into doing.

- **Frozen agent allow-list.** `acp_start` resolves its extra allowed programs from the server
  config (`agent_programs`), never from `db.enabled_agent_programs()` — that table is client-writable
  and would otherwise let a request widen the spawn surface. `db_agents_sync` is rejected outright
  (`403`).
- **Sandbox / tier clamping.** The server overwrites the caller-supplied `sandbox` and `tier`
  arguments on `acp_start` (and pins `tier` on `acp_set_permission_tier`) with the configured
  values, so a remote caller cannot request `sandbox="off"` or `tier="full"`. The default tier is
  `read-only` (fail-closed).
- **Pre-seeded authorized roots.** A headless host has no native folder picker, so authorized
  workspace roots come only from config (`workspace_roots`); `WorkspaceFsAccess` still enforces
  them for every `fs_*` / `git_*` call. No new path resolution is introduced by the server.

Known residual surface (documented, not yet hardened): the built-in allow-list still contains
general-purpose runtimes (`node` / `npx` / `python3` / `uvx`) that are themselves arbitrary code
executors, and `acp_start`'s `env` argument is caller-controlled.

## CI/CD

GitHub Actions workflows live in `.github/workflows/` and share two composite actions
(`.github/actions/setup-node`, `.github/actions/setup-rust`) so the toolchain/cache policy has a
single home.

`ci.yml` runs on push to `master`/`main` and on every PR:

1. **Lint / Typecheck / Test / Build (renderer)** — four parallel jobs. They mirror the pre-push
   hook; running them concurrently keeps the wall clock at the slowest job instead of the sum. Each
   job installs the pnpm store from cache (~20-40s).
2. **Tauri Bundle (deb / NSIS / dmg)** — three-platform matrix that installs the Tauri system deps,
   compiles Rust, and packages the app; the renderer is built inside `tauri build` via
   `beforeBuildCommand`.
3. **Cargo Test (workspace)** — from the repo root: `cargo fmt --check`,
   `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`, plus a guard that
   `crates/greywork-host/Cargo.toml` declares no `tauri` dependency. The pre-push hook runs the same
   three commands when a push touches Rust files.

Rust dependency caches come from `Swatinem/rust-cache` and are keyed with `shared-key: tauri`, so the
CI bundle matrix and the release workflow restore the same dependency artifacts (the key still
includes OS/arch and the rustc hash). Caches are only written on `master` and on tags: GitHub's cache
budget is 10 GB per repository, and per-PR copies of the ~600 MB desktop cache evict the `master`
entries, turning the next build into a full dependency recompile. The first run after a change to
`Cargo.lock`, `RUSTFLAGS`, or a job's cache key is a cold build by design.

`release.yml` runs on `v*` tags, extracts the release notes from `CHANGELOG.md`, and builds/uploads
deb / NSIS / dmg to a draft Release via `tauri-action`. Branch protection ensures all checks pass
before merge — if required check names change, update them in the branch protection settings.

## Design Principles

- **Thin Rust, Fat TypeScript**: UI and orchestration logic live in TS; Rust provides IPC bridges, sandboxing, and system access.
- **Shared Workbench**: Desktop and web share a single UI package to maximize code reuse.
- **Plugin System**: Uses Cordis micro-kernel for plugin lifecycle; skills are vendored in `.agents/skills/`.
- **No Runtime Web Clipboard**: Uses `@tauri-apps/plugin-clipboard-manager` due to WKWebView/WebKitGTK limitations (see ESLint rule in `eslint.config.js`).
