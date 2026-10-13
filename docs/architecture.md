# GreyWork Architecture

GreyWork is a monorepo implementing a desktop-first AI agent application. It uses pnpm workspaces with TypeScript packages in `packages/`, an Electron desktop shell in `apps/electron/`, and a headless Rust server (`apps/server/`) backed by shared domain logic in `crates/greywork-host/`.

## Monorepo Layout

```
greyWork/
├── apps/
│   ├── desktop/              # Renderer SPA (Vite + Vue), shared by the Electron shell and the server
│   ├── electron/             # Electron shell: main process + preload + sidecar orchestration
│   └── server/               # Headless axum server: HTTP command endpoint + WS events + login
├── crates/
│   └── greywork-host/        # Shared domain logic (host-transport-free) used by every host
├── packages/
│   ├── core/                 # Shared types & math (no deps)
│   ├── editor/               # File system, Git, CodeMirror abstractions
│   ├── agents/               # Agent domain logic (roles, events, orchestration)
│   ├── llm/                  # LLM provider clients (OpenAI-compatible stream → IPC)
│   ├── acp/                  # Agent Client Protocol client (host commands + WebSocket)
│   ├── shell/                # Provider registry & transport data plane
│   ├── plugins/              # Plugin market source adapters + types
│   ├── cowork/               # Co-operative workspace engine
│   └── workbench/            # Shared UI package: shell, views, plugin runtime
├── plugin-market/            # Plugin registry source + signing
└── .agents/skills/           # Installed agent skills (read natively by the ACP agent)
```

There is no lockfile for skills: the host is only an installer (`services/skills_market.rs` writes a
snapshot into `<workspace>/.agents/skills/<id>/`), and the ACP agent picks the directory up at its
next session. Installed-from-market records are tracked renderer-side in `localStorage`.

Skills come from two places, both landing in the same directory:

- **Market** (`services/skills_market.rs`) — search/download from skills.sh through the host (the renderer
  never reaches the market directly).
- **Bundled** (`services/bundled_skills.rs`) — content compiled into the host binary with `include_str!`, so
  installing one needs no network and no configured source. `skills_bundled_list` serves the
  catalogue, `skills_install_bundled` resolves the files by id.

Both write through `skills_market::write_skill_snapshot`, which is the single place that decides
what a skill directory may contain (path sanitising, file-count and per-file size caps). The first
bundled skill is `ffmpeg-media`, a driver for the `ffmpeg` CLI: the host ships the instructions, the
agent runs the tool, and the artefacts land in the workspace where the preview viewers pick them up.

**Skills in isolated runs.** A `worktree` run provisions an isolated snapshot, which — for a git
source — only contains **committed** files, so uncommitted `.agents/skills` would not reach the
agent. `worktree_provision` therefore carries the source's `.agents/skills` into the snapshot
(`infra/worktree/skills.rs`): each entry is symlinked (a directory the agent reads, not code the
host runs), guarded like `.agents/linked` — the entry must be a safe relative path and, in a git
source, git-ignored (so the link does not pollute the agent's change view). The renderer passes an
optional `skills` filter so a cowork run can bring only the teammates-selected subset (`None` =
all, `[]` = none); the filter only bites in `worktree` mode, since every other mode uses the source
directory as the workspace and the skills are visible as-is.

## MCP servers

MCP servers are declared per session: the renderer passes the enabled set (or a run-level subset)
to `acp_new_session` / `acp_load_session`, and the host filters it by the agent's declared
`mcpCapabilities` (`services/acp_host/session.rs`) before forwarding it in `session/new.mcp_servers`.
The agent connects to them and merges their tools — the host never proxies tool calls. Skipped
servers (e.g. an `http` server on an agent that only supports `stdio`) come back as
`skippedMcpServers` so the UI can say why.

## Subagents (protocol-level)

An ACP agent may delegate to _subagents_ it creates internally and expose them as child sessions
(RFD: Subagent Sessions). This is distinct from GreyWork's own **orchestration tasks** (the
`runs` store's planner/subtask board, which starts a separate agent process per subtask): a
protocol subagent shares the parent's ACP connection and is announced with a `subagent_update`
session update.

Routing lives in `packages/workbench/src/stores/agent/subagent.ts`, driven by the single
`acp://event` listener: the listener asks the runs bridge first (app orchestration), then this
slice, then falls through to the main session stream. The slice keeps the parent→child tree,
current work state (`running` / `idle` / `requires_action` / `unknown`), inter-session messages
(`session_message*`) and a per-subagent transcript, surfaces an indicator chip in the conversation
header, and notifies once when a child settles (`stopReason` end_turn / cancelled / error). Child
traffic for a not-yet-announced session is buffered briefly and replayed on announcement, with a
bounded fallback (size cap + 2s timer) that hands orphaned traffic back to the main stream so it is
never silently dropped.

Cancelling one child reuses ACP `session/cancel` targeted at the child's session id — a new host
command `acp_cancel_session` (it does not reap the process). Note the pinned Rust SDK
(`agent-client-protocol-schema` 1.9.1) does not yet model the draft subagent variants, so the
host currently drops `subagent_update` (non-fatally — the connection and turn survive, and
child-session chunks still arrive); the renderer path is forward-compatible and activates once the
SDK carries the variants.

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
apps/*      ← workbench (desktop = renderer; electron = shell; server = Rust host)
```

**Key rules (enforced by ESLint):**

- `packages/agents/src/**` can only import from `@greywork/core` from within the `@greywork/*` scope — domain logic stays decoupled from other packages.
- No `packages/*` may import from `apps/*` (no reverse dependency).

### Package Descriptions

| Package               | Purpose                                                                                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@greywork/core`      | Shared TypeScript types (vectors, bounding boxes, version info) and math utilities (clamp, lerp, vector ops). Leaf-level.                                                                                                                                                                       |
| `@greywork/editor`    | File system, Git, and CodeMirror abstractions. The memory-backed mocks ship for browser/unit contexts; the real Git service talks to the host's `git_*` commands (implemented in `crates/greywork-host/src/infra/git.rs`), which run the git CLI strictly inside the authorized workspace root. |
| `@greywork/agents`    | AI agent domain: role definitions, state machine, event model, task orchestration pipeline.                                                                                                                                                                                                     |
| `@greywork/llm`       | LLM provider clients using OpenAI-compatible streaming protocol. Bridges to the host's `llm_*` commands for the Rust `LlmHost` backend.                                                                                                                                                         |
| `@greywork/acp`       | Agent Client Protocol client — session transport (host commands and WebSocket), permission mapping, event model.                                                                                                                                                                                |
| `@greywork/shell`     | Provider registry and desktop communication data plane. Contains ACP agent backend presets and model provider enums.                                                                                                                                                                            |
| `@greywork/plugins`   | Plugin market source adapters (skills.sh registry search/download) and AI command strategy types.                                                                                                                                                                                               |
| `@greywork/cowork`    | Co-operative workspace engine for collaborative sessions.                                                                                                                                                                                                                                       |
| `@greywork/workbench` | Complete shared UI package used by both desktop and web. Exports a single `GreyWorkWorkbench` entry point. Includes the plugin runtime (Cordis micro-kernel), router, stores, i18n, theme, and all views.                                                                                       |

## Build & Package

- All packages use source-direct execution (TypeScript via Vite/vue-tsc), no separate build step for packages.
- The desktop app packages via electron-builder (`apps/electron/electron-builder.yml`); `pnpm build` produces the renderer SPA that both the Electron shell and the server serve.
- Domain logic lives in `crates/greywork-host/` (a single Cargo workspace at the repo root, one `Cargo.lock`), shared by both hosts. It is organised into four layers — `core/` (leaf utilities), `infra/` (DB, git, http, workspace FS), `services/` (LLM, ACP, MCP, RAG, office, skills, cron), `channels/` (chat transports) and `app/` (the `commands` face) — with a strict downward dependency direction (L0 ← L1 ← L2 ← L3 ← L4). `lib.rs` re-exports every module back to the crate root, so `greywork_host::<mod>` paths are unchanged. Major domains: `services/llm/` (OpenAI-compatible stream -> events), `services/acp_host.rs`, `services/mcp*.rs`, `services/host_exec.rs` (automation-queue consumer, **not** process exec — that is `infra/process_guard.rs`), `infra/http.rs` / `services/web_fetch.rs`, `infra/workspace_fs/` (authorized workspace root resolution + file reads) and `infra/git.rs` (git CLI surfaced as `git_*` commands, scoped to the authorized root). The command face has a single source of truth: `commands::COMMANDS` + `commands::dispatch`.
- `apps/electron/src/main/` keeps the host-specific modules (window / tray / notify / close-guard / browser-view / picker / plugin-window / sidecar / auth).
- `apps/server/` is the headless host (see below).
- Patches are applied to dependencies via `patches/` directory (e.g., `@univerjs/engine-render`, `exceljs`).

## Testing

- Each package with testable logic has a `tests/` directory using Vitest.
- `pnpm -r test` runs all tests across packages with coverage enabled where configured.
- Rust tests run via `cargo test --locked` from the **repo root** (single workspace: `greywork-host` + server).
- Coverage thresholds are configured per-package in `vitest.config.ts`.
- **Cross-language ACP gate**: `pnpm --filter @greywork/acp test:integration` drives the real
  renderer-side ACP client (`@greywork/acp` → the host-command transport → `POST /api/command` +
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
the server-side security policy. It carries no GUI-toolkit dependency.

### Reuse boundary

The command face has one source of truth: `greywork_host::commands::COMMANDS` (metadata) and
`commands::dispatch(name, args, ctx)`; the server routes `POST /api/command` into `dispatch`.
Commands marked `desktop_only` are rejected server-side and are implemented by the Electron main
process instead — the mirror list in `apps/electron/src/shared/desktop-only.ts` is asserted against
`/api/commands` so the two sides cannot drift (the Electron shell's own unit tests pin its shape).

### Configuration

Loaded as `defaults → <data_dir>/server.json → GREYWORK_* env vars` (env wins). Fields: `bind`,
`data_dir`, `home_dir`, `session_ttl_secs`, `password_hash` / `password`, `agent_programs`,
`workspace_roots`, `tier`, `secure_cookie`, `allowed_origins`,
`frame_origins` (`GREYWORK_FRAME_ORIGINS`, see [Security headers](#security-headers)),
`automation_host_primary` (`GREYWORK_AUTOMATION_HOST_PRIMARY`, see
[Automations](#automations)), `static_dir` (`GREYWORK_STATIC_DIR`, see
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

| Method | Path            | Auth | Notes                                                              |
| ------ | --------------- | ---- | ------------------------------------------------------------------ |
| GET    | `/api/health`   | no   | `{status, version}`                                                |
| POST   | `/api/login`    | no   | `{password}` → `{token}` + `Set-Cookie`                            |
| POST   | `/api/logout`   | yes  | clears cookie + server session                                     |
| GET    | `/api/session`  | yes  | `{authenticated, expiresAt}`                                       |
| GET    | `/api/commands` | yes  | command metadata (`auth` / `desktopOnly` / `binary` / `available`) |
| POST   | `/api/command`  | yes  | `{command, args}` → the command's return value, verbatim           |
| GET    | `/api/media`    | yes  | `?path=` → media bytes with HTTP `Range` support                   |
| GET    | `/api/events`   | yes  | WebSocket; frames are `{event, payload}`                           |

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

| Header                      | Value                                                               | Why                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | a strict same-origin policy (see the directives in `middleware.rs`) | the desktop shell loads the same served SPA and inherits this policy — there is deliberately no second, shell-specific CSP                      |
| `X-Frame-Options`           | `DENY`                                                              | clickjacking guard for older browsers (`frame-ancestors 'none'` covers modern ones)                                                             |
| `Referrer-Policy`           | `no-referrer`                                                       | never leak the self-hosted URL/paths to outbound links                                                                                          |
| `Permissions-Policy`        | `camera=(), microphone=(), …` (omits `clipboard-*`)                 | the UI uses `navigator.clipboard` for its copy buttons, so `clipboard-*` is deliberately left unset; everything else is unused and denied       |
| `X-Content-Type-Options`    | `nosniff`                                                           | don't let the browser sniff JSON/binary into an executable type                                                                                 |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`                               | **only when `secure_cookie` is set** — that flag is the "behind a TLS proxy" signal; over plain HTTP HSTS is meaningless and can lock users out |

`GREYWORK_FRAME_ORIGINS` appends a `frame-src` allow-list for cloud Office viewers. Origins are
normalized by the shared `greywork_host::csp::normalize_frame_origin` (both the server policy and
the host-fact query need the same form); anything that could rewrite the policy (whitespace,
quotes, semicolons) is dropped and named in the startup log.

The server does **not** add request timeouts or concurrency limits: `acp_start`, LLM streaming,
large `web_fetch`, and 32 MB binary reads legitimately run for minutes, and long-lived WebSockets
must stay open. The only abuse-prone entry point is `/api/login`, which `LoginThrottle` already
covers (5 failures → `429`).

### Automations

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
non-loopback without it logs a cleartext-credential warning at startup. See [`docs/packaging.md`](./packaging.md) for the
deployment guide, volume layout, password strategies, and the full capability trade-off matrix.

### Security model

The **authentication boundary is the security boundary**: a valid session can spawn agent
processes, so the controls below limit what the _web UI_ can be tricked into doing.

- **Frozen agent allow-list.** `acp_start` resolves its extra allowed programs from the server
  config (`agent_programs`), never from `db.enabled_agent_programs()` — that table is client-writable
  and would otherwise let a request widen the spawn surface. `db_agents_sync` is rejected outright
  (`403`).
- **Tier clamping.** The server overwrites the caller-supplied `tier` argument on `acp_start`
  (and pins it on `acp_set_permission_tier`) with the configured value, so a remote caller cannot
  request `tier="full"`. The default tier is `read-only` (fail-closed).
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
2. **Electron Bundle** — three-platform matrix that builds the sidecar binary, the renderer SPA and
   the shell (`pnpm electron:prep`), then packages an unpacked app with electron-builder. Actual
   installers are produced by `release.yml` (see below).
3. **Cargo Test (workspace)** — from the repo root: `cargo fmt --check`,
   `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`, plus a guard that
   `crates/greywork-host/Cargo.toml` declares no `tauri` / `electron` dependency. The pre-push hook
   runs the same three commands when a push touches Rust files.
4. **ACP E2E (renderer TS × Rust host)** — builds `greywork-server` and runs the cross-language ACP
   gate described under Testing. It needs no browser and no renderer bundle (it only talks to
   `/api`), and it reuses `shared-key: rust` so it does not add a cache entry.

Rust dependency caches come from `Swatinem/rust-cache` and are keyed with `shared-key: rust`, so the
CI packaging job and the release workflow restore the same dependency artifacts (the key still
includes OS/arch and the rustc hash). Caches are only written on `master` and on tags: GitHub's cache
budget is 10 GB per repository, and per-PR copies of the ~600 MB dependency cache evict the `master`
entries, turning the next build into a full dependency recompile. The first run after a change to
`Cargo.lock`, `RUSTFLAGS`, or a job's cache key is a cold build by design.

`release.yml` runs on `v*` tags: a first job extracts the release notes from `CHANGELOG.md` and
creates a draft Release, then a three-platform matrix builds the Electron installers (AppImage /
NSIS / dmg) and uploads them to it. Branch protection ensures all checks pass before merge — if
required check names change, update them in the branch protection settings.

`docker.yml` is deliberately a separate workflow with its own `paths` filter (Dockerfile, compose
files, server/host/renderer sources, lockfiles) so it neither runs on unrelated PRs nor perturbs
`ci.yml`'s job set (and therefore branch protection's required-check list). It builds the image,
starts it with a known password, polls `/api/health`, and asserts that `/` really serves the SPA
(`<div id="app">`) and that the CSP header is present — a plain health check would pass on an image
whose UI 404s. It does **not** use BuildKit's `type=gha` cache: the repository's 10 GB cache budget is
already saturated by the Rust dependency caches.

## Native model agent loop (`services::llm::agent`)

Three conversation paths share one OpenAI-compatible transport (`services::llm::transport`) and
differ only in what they declare to the model:

| Path             | Entry             | Tools                                | Where the loop lives                  |
| ---------------- | ----------------- | ------------------------------------ | ------------------------------------- |
| Single-turn chat | `llm_chat_start`  | none                                 | one request                           |
| **Native agent** | `llm_agent_start` | `read_file` / `list_dir` / `git_log` | host (`services::llm::agent::runner`) |
| ACP agent        | `acp_send`        | whatever the external agent declares | external process                      |

### Why the loop runs in the host

The tool surface is read-only, so every call is auto-approved under all three permission tiers —
no interactive confirmation branch exists. That is what lets the loop live in the host: the
renderer, the remote-assistant pipeline (`stores/remote-assistant/pipeline.ts`) and the automation
queue's host fallback (`services/host_exec.rs`) all reuse one implementation, and aborting is
`JoinHandle::abort()` exactly as in `llm_chat_stop`.

### Trust boundary

Tools execute **inside GreyWork, inside its own authorization surface** — `read_file` /
`list_dir` call the same `workspace_fs` functions as the `fs_read_text_file` / `fs_list_dir`
commands, and `git_log` calls the same `git_log`. There is deliberately **no second allow-list**:
a path outside the authorized roots fails in `resolve_existing`, which canonicalizes _before_
checking, so `../` escapes and symlinks are rejected too.

This is a different trust relationship than "mounting these capabilities as MCP tools for an
external agent": there the external agent's own sandbox is the boundary; here the host's
authorization ledger is.

### Protocol details worth knowing

- **Streaming `tool_calls` are fragmented.** `function.arguments` arrives token by token, tagged
  by `index`. `ToolCallAccumulator` reassembles per index; reading only the last chunk yields
  truncated JSON. `take()` clears the accumulator so a reused accumulator cannot append a new
  round's `index:0` onto the previous call's arguments.
- **Missing `id` / `name` is synthesized, not dropped.** The assistant message is constructed
  host-side, so a synthesized id keeps the `assistant.tool_calls` ↔ `tool.tool_call_id` pairing
  self-consistent. Dropping the call instead would leave the model without a tool result and
  looping on the same request.
- **Truncation is visible to the model.** Tool output is capped (`MAX_TOOL_OUTPUT_CHARS`), and the
  cap states how much was dropped. Silently truncating makes the model reason confidently over
  partial content.
- **Authorization failures are worded identically to "does not exist".** Telling the model
  "unauthorized" maps the boundary for it.
- **Running out of rounds still produces an answer.** After `max_rounds`, one final request is
  sent with `tool_choice: "none"` — tools stay declared (so the model still knows what it could
  have used) but calls are forbidden. Stripping `tools` instead makes the model assume they do
  not exist and hallucinate having read a file.

### Event contract

The same `llm://event` broadcast as chat, with two extra kinds. `clientToken` filtering and the
event envelope are identical, which is why the store's tool timeline needed no new plumbing — it
reuses the ACP `ToolActivity` path via `lib/tool-activity.ts`.

| kind              | payload                                           | meaning                                |
| ----------------- | ------------------------------------------------- | -------------------------------------- |
| `llm-tool-call`   | `id`, `name`, `input`, `round`                    | model requested a tool                 |
| `llm-tool-result` | `id`, `ok`, `error`, `summary`, `path`, `preview` | tool finished (`preview` is truncated) |

`llm_agent_start` / `llm_agent_stop` keep a **separate handle table** from `llm_chat_*`: an agent
turn runs for many rounds and minutes, so a shared table would let one stop the other.

### Enabling it

Per model provider (`ModelProviderConfig.agentMode`), not globally — tool calling is an
endpoint/model capability, and some gateways reject a request carrying `tools` with `400` while
another provider works fine at the same moment. `agentMaxRounds` caps tool rounds (host clamps to
a hard ceiling).

## File preview (viewer dispatch)

Preview is a pure extension-name dispatch. `packages/workbench/src/lib/viewer.ts` holds the kind
tables — a new kind must be registered in each of them:

- `EXT_KIND` maps an extension to a `ViewerKind`; unknown extensions fall back to `raw` (CodeMirror
  plain text), so a file never "fails to open".
- `BINARY_KINDS` is a **whitelist** of kinds that must be read as bytes. Reading binary as text is
  irreversible (UTF-8 decode), so the failure mode is "file is corrupt", not a visible error.
- `MEDIA_LIMITS` marks kinds that read through the relaxed `fs_read_media` channel instead of the
  20 MB `fs_read_binary` one: video (128 MB) and `3d` (64 MB). GIS is deliberately **not** here — a
  vector file large enough to need it is not something you want painted in a preview pane, so it
  stays on the 20 MB channel.

The viewer component table is `packages/workbench/src/features/preview/PreviewSurface.vue`
(`Record<ViewerKind, Component>` — a missing key is a compile error). Every viewer is a
`defineAsyncComponent` so heavy renderers (Univer, pdf.js, three.js, MapLibre GL) stay out of the
main chunk. A viewer receives only `{ tab }` and reads its own bytes through
`lib/preview-content.ts` (`usePreviewText` / `usePreviewBinary` / `usePreviewMedia`); tabs
themselves hold no content.

Two read caps live in the host, not the renderer (`crates/greywork-host/src/infra/workspace_fs/`):
`MAX_BINARY_BYTES` = 20 MB for `fs_read_binary`, and `MAX_MEDIA_BYTES` = 128 MB for
`fs_read_media`. `fs_read_media` clamps a caller-supplied `maxBytes` to its own ceiling, so the
renderer can ask for a per-kind budget but can never raise the host's hard cap. Both are **errors**
when exceeded, never truncation — a half file surfaces as "corrupt format", which is far harder to
diagnose than a size message.

### Media playback: stream, don't buffer

Reading a video into memory and handing `<video>` a `blob:` URL does **not** work for real files:
the IPC transfer plus the synchronous `new Blob` copy freeze the renderer, and WebKit buffers the
whole blob before it starts playing (seeking is effectively broken). The symptom is a spinner with
no error anywhere.

So both hosts stream: the server exposes `GET /api/media?path=…` with **HTTP Range** support
(`apps/server/src/routes/media.rs`), serving 1 MB chunks. The slice logic
(`workspace_fs::fs_media_slice`, which also owns the MIME table) authorizes through
`WorkspaceFsAccess::resolve_existing` — the _same_ check `fs_read_media` uses, so there is no second
allow-list to keep in sync. `packages/host-ipc/src/media.ts` returns that same-origin address in
server mode (which is what the Electron shell runs), so `lib/preview-content.ts`
(`resolvePreviewMedia`) gets a stream everywhere a host exists and only browser-preview mode falls
back to bytes. The server CSP already allows `media-src 'self'`.

### 3D and GIS: container before content

`ModelViewer.vue` (glb / gltf, three.js + `OrbitControls`) and `MapViewer.vue` (geojson / shp,
MapLibre GL) both need a DOM container to exist **before** the bytes arrive: the `data` watcher runs
in Vue's pre-flush phase, i.e. before the component re-renders, so a canvas placed in a `v-else`
branch is still `null` when the renderer is constructed — and once the branch does render, nothing
re-triggers the load. Both viewers therefore render their container as soon as there is no read
error, and show the loading state as an overlay.

`ModelViewer` uses the media channel with the `bytes` preference (`usePreviewMedia(tab, "bytes")`):
`GLTFLoader` needs the whole buffer, so the streaming address is of no use here. A `.gltf` that references sibling `.bin` / texture files can never
resolve (the preview only receives the one path), so that failure is turned into an explicit
"export a self-contained .glb" message instead of an empty scene. Teardown (on content change and
on unmount) traverses the object graph disposing geometries, materials and textures — one tab
switch is one WebGL context, and skipping this leaks GPU memory.

`MapViewer` reads whole bytes through `fs_read_binary` and reads a sibling `.prj` / `.dbf` on a
best-effort basis (missing or unauthorized degrades to geometry-only). It uses an **empty style**
(`{version: 8, sources: {}, layers: []}`): no basemap means no external requests, so the CSP is
untouched. Features are split into point / line / polygon layers by `geometry-type` (a collection
mixing all three is normal), and the view is fitted to the data's bounding box, computed in
`lib/geojson.ts` as a pure function so it can be unit-tested without MapLibre.

## Design Principles

- **Thin Rust, Fat TypeScript**: UI and orchestration logic live in TS; Rust provides the command surface, process hosting, and system access. Agents keep their own permission models — the host no longer sandboxes them at the OS level.
- **Shared Workbench**: Desktop and web share a single UI package to maximize code reuse.
- **Plugin System**: Uses Cordis micro-kernel for plugin lifecycle; skills are vendored in `.agents/skills/`.
- **Clipboard goes through the host**: the facade exposes `hostClipboard()` (Electron main-process `clipboard` / browser Web API), because some renderers silently resolved the Web Clipboard API without writing (see ESLint rule in `eslint.config.js`).
