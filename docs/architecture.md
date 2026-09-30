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
└── .agents/skills/           # Installed agent skills (read natively by the ACP agent)
```

There is no lockfile for skills: the host is only an installer (`skills_market.rs` writes a
snapshot into `<workspace>/.agents/skills/<id>/`), and the ACP agent picks the directory up at its
next session. Installed-from-market records are tracked renderer-side in `localStorage`.

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
- Domain logic lives in `crates/greywork-host/` (a single Cargo workspace at the repo root, one `Cargo.lock`), shared by both hosts. Major domains: `llm.rs` (OpenAI-compatible stream -> events), `acp_host.rs`, `mcp*.rs`, `host_exec.rs` (automation-queue consumer, **not** process exec — that is `sandbox.rs` + `process_guard.rs`), `http.rs` / `web_fetch.rs`, `workspace_fs.rs` (authorized workspace root resolution + file reads) and `git.rs` (git CLI surfaced as `git_*` commands, scoped to the authorized root). The command face has a single source of truth: `commands::COMMANDS` + `commands::dispatch`.
- `apps/desktop/src-tauri/src/` keeps only `#[tauri::command]` wrappers and truly host-specific modules (`sys` / `tray` / `notify` / `close_guard` / `plugin_window` / `TauriHost`).
- `apps/server/` is the headless host (see below).
- Patches are applied to dependencies via `patches/` directory (e.g., `@univerjs/engine-render`, `exceljs`).

## Testing

- Each package with testable logic has a `tests/` directory using Vitest.
- `pnpm -r test` runs all tests across packages with coverage enabled where configured.
- Rust tests run via `cargo test --locked` from the **repo root** (single workspace: desktop shell + `greywork-host` + server).
- Coverage thresholds are configured per-package in `vitest.config.ts`.
- **Cross-language ACP gate**: `pnpm --filter @greywork/acp test:integration` drives the real
  renderer-side ACP client (`@greywork/acp` → `TauriIpcTransport` → `POST /api/command` +
  `WS /api/events`) against a real `greywork-server` and a fake agent, asserting a full
  `initialize → session/new → prompt → agent_message_chunk → prompt-done` round trip. The two ACP
  SDKs (TS `@agentclientprotocol/sdk` vs Rust `agent-client-protocol`) are independent release
  lines, so "each side compiles and unit-tests green" does **not** imply they interoperate. It
  needs `cargo build -p greywork-server` first (it never builds for you) and is deliberately kept
  out of `pnpm -r test` so the plain test job needs no compiled artifacts. The Rust-side counterpart
  (`apps/server/tests/acp_host.rs`) covers the `AcpHost` command surface through `dispatch` on all
  three platforms.

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
`workspace_roots`, `sandbox`, `tier`, `secure_cookie`, `allowed_origins`,
`frame_origins` (`GREYWORK_FRAME_ORIGINS`, see [Security headers](#security-headers)),
`automation_host_primary` (`GREYWORK_AUTOMATION_HOST_PRIMARY`, see
[Scheduled tasks](#scheduled-tasks)), `static_dir` (`GREYWORK_STATIC_DIR`, see
[Static hosting](#static-hosting-spa)).

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

### Security headers

Every response (API and static alike) carries a fixed set of headers from `middleware::security_headers`.
The CSP is computed once at router-assembly time from the config, not per response:

| Header                      | Value                                                                    | Why                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | mirrors the desktop `tauri.conf.json` CSP, plus `media-src 'self' blob:` | the desktop policy is the strongest evidence of what the app actually needs; `media-src blob:` is for inbound video/voice thumbnails            |
| `X-Frame-Options`           | `DENY`                                                                   | clickjacking guard for older browsers (`frame-ancestors 'none'` covers modern ones)                                                             |
| `Referrer-Policy`           | `no-referrer`                                                            | never leak the self-hosted URL/paths to outbound links                                                                                          |
| `Permissions-Policy`        | `camera=(), microphone=(), …` (omits `clipboard-*`)                      | the UI uses `navigator.clipboard` for its copy buttons, so `clipboard-*` is deliberately left unset; everything else is unused and denied       |
| `X-Content-Type-Options`    | `nosniff`                                                                | don't let the browser sniff JSON/binary into an executable type                                                                                 |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`                                    | **only when `secure_cookie` is set** — that flag is the "behind a TLS proxy" signal; over plain HTTP HSTS is meaningless and can lock users out |

`GREYWORK_FRAME_ORIGINS` appends a `frame-src` allow-list for cloud Office viewers. Origins are
normalized by the shared `greywork_host::csp::normalize_frame_origin` (the server CSP, the desktop
CSP drift test, and the host-fact query all need the same form); anything that could rewrite the
policy (whitespace, quotes, semicolons) is dropped and named in the startup log.

The server does **not** add request timeouts or concurrency limits: `acp_start`, LLM streaming,
large `web_fetch`, and 32 MB binary reads legitimately run for minutes, and long-lived WebSockets
must stay open. The only abuse-prone entry point is `/api/login`, which `LoginThrottle` already
covers (5 failures → `429`).

### Scheduled tasks

Due automations are consumed by the renderer's 30 s poll loop when a browser is present. The host
process also consumes them, and `GREYWORK_AUTOMATION_HOST_PRIMARY=1` decides **which role** it
plays: unset, it only claims rows that have been due for over 2 minutes (a fallback for a closed
or busy renderer); set, the threshold is zero and the host is the primary executor — tasks run on
the server without any browser open. Both roles share the same row-level atomic claim
(`automation_due_finish`'s `WHERE status='pending'`), so a renderer and the host present at once
never double-execute. The default is `false`, so upgrading an existing deployment does not make it
start running tasks on its own. Unattended runs resolve model credentials from the **server
process's** environment, so those variables must be injected (e.g. via compose).

### Deployment (Docker)

The server is packaged as a multi-stage image: `node:22-bookworm-slim` builds the SPA,
`rust:1-bookworm` compiles `greywork-server`, and a `debian:bookworm-slim` runtime carries the
binary plus `git`/`ca-certificates`. The runtime image deliberately ships **no** Node/Python
toolchain — the frozen agent allow-list resolves against whatever the operator installs in a
derived image and declares via `GREYWORK_AGENT_PROGRAMS`. The binary carries a `healthcheck`
subcommand so the image needs no `curl`/`wget`.

`docker-compose.yml` publishes `8787`, mounts a named `/data` volume, sets
`no-new-privileges`, and runs as uid 10001. The server itself does no TLS, so production belongs
behind a TLS reverse proxy (Caddy / nginx / Traefik) with `GREYWORK_SECURE_COOKIE=1`; binding
non-loopback without it logs a cleartext-credential warning at startup. A separate
`docker-compose.sandbox.yml` override adds `seccomp=unconfined` + `SYS_ADMIN`/`NET_ADMIN` for
operators who need the agent sandbox's `fs`/`full` tiers — in a default container the `bwrap` probe
always fails and the sandbox degrades to `off`. See [`docs/packaging.md`](./packaging.md) for the
deployment guide, volume layout, password strategies, and the full capability trade-off matrix.

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
4. **ACP E2E (renderer TS × Rust host)** — builds `greywork-server` and runs the cross-language ACP
   gate described under Testing. It needs no browser and no renderer bundle (it only talks to
   `/api`), and it reuses `shared-key: tauri` so it does not add a cache entry — it pays for the
   Tauri system deps it does not strictly need rather than risk evicting the `master` cache.

Rust dependency caches come from `Swatinem/rust-cache` and are keyed with `shared-key: tauri`, so the
CI bundle matrix and the release workflow restore the same dependency artifacts (the key still
includes OS/arch and the rustc hash). Caches are only written on `master` and on tags: GitHub's cache
budget is 10 GB per repository, and per-PR copies of the ~600 MB desktop cache evict the `master`
entries, turning the next build into a full dependency recompile. The first run after a change to
`Cargo.lock`, `RUSTFLAGS`, or a job's cache key is a cold build by design.

`release.yml` runs on `v*` tags, extracts the release notes from `CHANGELOG.md`, and builds/uploads
deb / NSIS / dmg to a draft Release via `tauri-action`. Branch protection ensures all checks pass
before merge — if required check names change, update them in the branch protection settings.

`docker.yml` is deliberately a separate workflow with its own `paths` filter (Dockerfile, compose
files, server/host/renderer sources, lockfiles) so it neither runs on unrelated PRs nor perturbs
`ci.yml`'s job set (and therefore branch protection's required-check list). It builds the image,
starts it with a known password, polls `/api/health`, and asserts that `/` really serves the SPA
(`<div id="app">`) and that the CSP header is present — a plain health check would pass on an image
whose UI 404s. It does **not** use BuildKit's `type=gha` cache: the repository's 10 GB cache budget is
already saturated by the Rust dependency caches.

## Design Principles

- **Thin Rust, Fat TypeScript**: UI and orchestration logic live in TS; Rust provides IPC bridges, sandboxing, and system access.
- **Shared Workbench**: Desktop and web share a single UI package to maximize code reuse.
- **Plugin System**: Uses Cordis micro-kernel for plugin lifecycle; skills are vendored in `.agents/skills/`.
- **No Runtime Web Clipboard**: Uses `@tauri-apps/plugin-clipboard-manager` due to WKWebView/WebKitGTK limitations (see ESLint rule in `eslint.config.js`).
