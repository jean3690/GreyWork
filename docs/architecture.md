# GreyWork Architecture

GreyWork is a monorepo implementing a desktop-first AI agent application. It uses pnpm workspaces with TypeScript packages in `packages/`, an Electron desktop shell in `apps/electron/`, two renderer frontends (`apps/desktop` and `apps/web`) built from the same `@greywork/workbench` sources, and a headless Node host (`apps/host-node/`, the former Rust `apps/server/` + `crates/greywork-host/` — migrated and deleted, see `docs/node-backend-migration.md`). A separate Java control plane (`back/grey`) owns accounts, channels, the model gateway, storage and automations; its admin console is `apps/admin`.

## Monorepo Layout

```
greyWork/
├── apps/
│   ├── desktop/              # Desktop renderer SPA (Vite + Vue), served by the Electron shell / host
│   ├── web/                  # Browser front: same workbench, narrower FrontSpec
│   ├── electron/             # Electron shell: main process + preload + sidecar orchestration
│   ├── host-node/            # Headless Node host: HTTP command endpoint + WS events + login
│   └── admin/                # Admin console SPA for the Java control plane (standalone, no workbench)
├── back/
│   └── grey/                 # Java control plane (Spring Boot 4 + MyBatis-Plus + MySQL + Redis)
├── packages/
│   ├── core/                 # Shared types & math (no deps)
│   ├── editor/               # File system, Git, CodeMirror abstractions
│   ├── agents/               # Agent domain logic (roles, events, orchestration)
│   ├── llm/                  # LLM provider clients (OpenAI-compatible stream → IPC)
│   ├── acp/                  # Agent Client Protocol client (host commands + WebSocket)
│   ├── shell/                # Provider registry & transport data plane
│   ├── host-ipc/             # Host command bridge (invoke / clipboard / window façade)
│   ├── plugin-types/         # Author-facing plugin typings (manifest / worker / render)
│   ├── plugins/              # Skill source adapters + plugin package types
│   ├── cowork/               # Co-operative workspace engine
│   ├── vite-config/          # Shared Vite config factory (base / pdf.js assets / dev proxy)
│   └── workbench/            # Shared UI package: shell, views, plugin runtime, front contract
└── .agents/skills/           # Installed agent skills (read natively by the ACP agent)
```

There is no lockfile for skills: the host is only an installer. `apps/host-node/src/skills.ts` writes
each skill into `<workspace>/.agents/skills/<id>/` (two-phase: validate the whole snapshot, then
commit) and links it into `.claude/skills/<id>` so Claude Code — which only reads its own directory —
sees the same skill; opencode reads `.agents/skills` directly, codex has no skill directory at all.
Installed records are tracked renderer-side in `localStorage`.

Skills come from a registry and from files the renderer already holds:

- **Registry** — `skills_search` / `skills_download` (handlers in `apps/host-node/src/commands.ts`)
  query the skills service (`https://greywork-skills.pages.dev` by default, overridable per call);
  the renderer never reaches it directly.
- **Local install** — the renderer hands files to `skills_install`, which applies the snapshot rules
  in `skills.ts`: path sanitising, file-count and per-file size caps.

`skills_bundled_list` currently returns an empty catalogue and `skills_install_bundled` throws: the
Rust host's compiled-in bundle (the `ffmpeg-media` driver) was not ported.

**Skills in isolated runs.** A `worktree` run provisions an isolated snapshot, which — for a git
source — only contains **committed** files, so uncommitted `.agents/skills` would not reach the
agent. `worktree_provision` therefore carries the source's `.agents/skills` into the snapshot
(`apps/host-node/src/worktree.ts`): each entry is symlinked (a directory the agent reads, not code the
host runs), guarded like `.agents/linked` — the entry must be a safe relative path and, in a git
source, git-ignored (so the link does not pollute the agent's change view). When `.claude/skills` is
git-ignored as well, the snapshot also gets the Claude compatibility link. The renderer passes an
optional `skills` filter so a cowork run can bring only the teammates-selected subset (`None` =
all, `[]` = none); the filter only bites in `worktree` mode, since every other mode uses the source
directory as the workspace and the skills are visible as-is.

## MCP servers

MCP servers are declared per session: the renderer passes the enabled set (or a run-level subset)
to `acp_new_session` / `acp_load_session`; both transports map them into the ACP `McpServer`
shape — `packages/acp/src/client.ts` for the direct WebSocket path, `apps/host-node/src/acp.ts`
for the host-managed path (stdio → `command`/`args`/`env`, http/sse → `type`/`url`/`headers`).
The agent connects to them and merges their tools; the host never proxies tool calls.
Servers whose transport the agent did not advertise in `mcpCapabilities` (or that lack `command` /
`url`) are skipped and reported back as `skippedMcpServers`.

## ACP session lifecycle

`acp_load_session` restores a persisted binding by capability: `session/resume` first when the
agent advertises `sessionCapabilities.resume` (no history replay, so the renderer skips its replay
guard), then `session/load` for agents that only support replay. If both fail the renderer falls
back to `session/new`, so a send is never blocked by a stale binding. When switching conversations
the renderer releases the previous session through `acp_close_session` (`session/close`) while
keeping the agent process alive; agents without the `close` capability return `false` and the
renderer proceeds. Turn cancellation sends ACP `session/cancel` before the JSON-RPC
`$/cancel_request` fallback, since the former is the protocol-defined prompt-cancel path.

Legacy session **modes** (`session/new` / `load` / `resume` returning `modes`) are adapted in the
renderer into a synthetic `legacy_session_mode` config option (`lib/acp-legacy-modes.ts`), so the
existing selector, workspace memory and global-default plumbing all work unchanged. Switching calls
the new host command `acp_set_mode` (`session/set_mode`), and `current_mode_update` notifications flow
back as `mode` events. Agents that already expose a real `mode` config option are left alone to avoid
a duplicate selector.

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
command `acp_cancel_session` (it does not reap the process). Note the host's agent→host router
(`apps/host-node/src/acp.ts::onAgentMessage`) only classifies `session/update` and
`session/request_permission`, so a standalone `subagent_update` notification is dropped
(non-fatally — the connection and turn survive, and child-session chunks still arrive); the renderer
path is forward-compatible and activates once the host forwards the method.

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
apps/*      ← workbench (desktop / web = frontends; electron = shell; host-node = Node host)
apps/admin  ← 独立依赖（vue / vue-router / pinia / element-plus），刻意不依赖 workbench
back/grey   ← 独立 JVM 服务，不在 pnpm 依赖图里
```

**Key rules (enforced by ESLint):**

- `packages/agents/src/**` can only import from `@greywork/core` from within the `@greywork/*` scope — domain logic stays decoupled from other packages.
- No `packages/*` may import from `apps/*` (no reverse dependency).

### Package Descriptions

| Package                 | Purpose                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@greywork/core`        | Shared TypeScript types (vectors, bounding boxes, version info) and math utilities (clamp, lerp, vector ops). Leaf-level.                                                                                                                                                           |
| `@greywork/editor`      | File system, Git, and CodeMirror abstractions. The memory-backed mocks ship for browser/unit contexts; the real Git service talks to the host's `git_*` commands (implemented in `apps/host-node/src/git.ts`), which run the git CLI strictly inside the authorized workspace root. |
| `@greywork/agents`      | AI agent domain: role definitions, state machine, event model, task orchestration pipeline.                                                                                                                                                                                         |
| `@greywork/llm`         | LLM provider clients using OpenAI-compatible streaming protocol. Bridges to the host's `llm_*` commands (`apps/host-node/src/llm.ts` / `llm-agent.ts`).                                                                                                                             |
| `@greywork/acp`         | Agent Client Protocol client — session transport (host commands and WebSocket), permission mapping, event model.                                                                                                                                                                    |
| `@greywork/shell`       | Provider registry and desktop communication data plane. Contains ACP agent backend presets and model provider enums.                                                                                                                                                                |
| `@greywork/plugins`     | Skill source adapters (registry search/download) and AI command strategy types.                                                                                                                                                                                                     |
| `@greywork/cowork`      | Co-operative workspace engine for collaborative sessions.                                                                                                                                                                                                                           |
| `@greywork/workbench`   | Complete shared UI package used by every frontend. Exports the `FrontSpec` contract, router factory, stores, i18n, theme, plugin runtime (Cordis micro-kernel) and all views.                                                                                                       |
| `@greywork/vite-config` | Single Vite config factory for all frontends: rxjs entry alias, pdf.js runtime assets, syntax floor, dev proxy and the shared `public/` directory. Apps only declare `base`, `outDir`, `devPort` and whether they emit root-level shared assets.                                    |

## Frontends (`apps/desktop` / `apps/web`)

One backend, many frontends. Every app is a thin bootstrap around `@greywork/workbench`: it awaits
`initRuntimeMode()`, calls `setFront(<FrontSpec>)`, then mounts `createAppRouter()`. The spec lives in
`packages/workbench/src/front/` and declares:

- `features` — which feature directories are installed. Each `features/<id>/spec.ts` contributes its
  routes, sidebar/search entries and a `setup()` hook. Removing a feature removes **both** its routes
  and its nav entry, and skips its listeners (e.g. the six chat-channel connections).
- `shell.panels` — which panels (sider / preview / workspace / activity / terminal) exist at all.
- `shell.wiring` — host-shell integrations (`queueBridge`, `tray`, `closeGuard`, `hostNotifications`).
  A frontend without a tray simply does not install the tray bridge.

Two rules keep this from silently bloating the bundle:

1. **Feature sets are static imports, not a lookup table.** `front/all.ts` imports each feature
   explicitly so Rollup can drop the ones no frontend references; a `Record<FeatureId, Feature>`
   lookup would retain every view.
2. **A production entry must declare its own spec, and there is no default** — `apps/desktop/src/main.ts`
   imports `ALL_FEATURES_FRONT`, `apps/web/src/main.ts` imports `WEB_FRONT`, both from their own
   `@greywork/workbench/front/*` subpath (never the barrel). `currentFront()` throws until `setFront()`
   has run, so a missing declaration fails loudly instead of silently loading the full set. Component
   tests get the full set from `tests/vitest.dom.setup.ts`.

   Removing the default is what makes the split pay for itself: while `currentFront()` referenced the
   full set, every frontend emitted every feature's route chunks (web and desktop had the same chunk
   count and differed by <0.02% in bytes). With the default gone, `apps/web` no longer contains
   `TeamView` / `AssistantsView` / channel views at all.

`apps/web` deliberately omits `channels` (opening a browser tab must not dial every IM channel),
`team` and `assistants`; it keeps `guid`, `conversation`, `automation` and `plugins`. Its smoke e2e
asserts the resulting feature ids, so a regression in the contract fails CI rather than surfacing as
a mysterious missing page.

Build-wise, `@greywork/vite-config` holds everything the fronts share. Each app only chooses `base`,
`outDir`, `devPort` and `emitsSharedAssets`; `publicDir` defaults to the single
`packages/workbench/public/` (boot script, logo, ~1.1k file icons) so the assets are not copied into
the repo N times. Desktop is served at the root by its sidecar, and `apps/web` is a separate
root-path deployment, so both emit the shared assets; merging them into one deployment would require
moving desktop to `base: "/desktop/"` and turning its `emitsSharedAssets` off.

## Admin console (`apps/admin` + `back/grey`)

The control plane is intentionally a **separate stack** from the desktop product:

- **Independent frontend.** `apps/admin` uses Vue 3 + Vite + Element Plus directly and does not
  import `@greywork/workbench`. The ops page therefore has no `FrontSpec`, no plugin runtime and no
  host bridge; it only speaks `/api/admin/**`. This keeps the jar self-contained and the console
  bundle free of product features.
- **Built into the backend.** `pnpm build:admin` writes to
  `back/grey/src/main/resources/static/admin`; the output is committed, so `mvn clean package`
  produces a jar that serves `/admin` without Node. Routing is hash-based (`/admin/#/users`), so the
  server only needs the single `/admin` → `index.html` mapping in `AdminPageController`.
- **Separate auth surface.** The console logs in with an admin-only email + password
  (`app_user.password_hash`, bcrypt); normal clients still use one-time enrollment codes or OIDC.
  All data endpoints stay behind `ROLE_ADMIN` and mutations are written to `audit_log`.
- **Deployment shape.** Java service (JRE 25 + MySQL + Redis) next to — not inside — the Node host.
  Env vars, endpoints and troubleshooting live in
  [control-plane-auth.md](control-plane-auth.md); frontend conventions in
  [apps/admin/README.md](../apps/admin/README.md).

## Build & Package

- All packages use source-direct execution (TypeScript via Vite/vue-tsc), no separate build step for packages.
- `pnpm build` builds **both** fronts (`build:desktop` → `apps/desktop/dist`, `build:web` →
  `apps/web/dist`). Deployments build only what they serve: the Electron packaging script and the
  Docker image use `build:desktop`, since both serve the desktop SPA.
- `pnpm build:admin` builds the ops console into the Java backend resources (see above); it is not
  part of `pnpm build` because the control plane ships its own jar.
- The desktop app packages via electron-builder (`apps/electron/electron-builder.yml`).
- The headless host is `apps/host-node/` (Node ≥ 22, ESM): the command face's frozen metadata snapshot lives in `apps/host-node/src/command-manifest.json`, handlers are registered in `src/commands.ts` (`HANDLERS` + `dispatch`), and the domain modules mirror the former Rust layout — `sheet.ts` (legacy `.xls` via `@e965/xlsx` + a dedicated ODS parser), `mcp.ts` (MCP client / plugin proxy / registry), `office.ts` (cloud preview / OAuth / LibreOffice), `llm-agent.ts` (local-model tool rounds), `channels.ts` (chat transports + media), `acp.ts`, `git.ts`, `rag.ts`, `session-store.ts`, `workspace-access.ts` (authorized-root resolution), `terminal.ts` (node-pty).
- `apps/electron/src/main/` keeps the host-specific modules (window / tray / notify / close-guard / navigation / menu / logger / browser-view / picker / plugin-window / sidecar / auth).
- Patches are applied to dependencies via `patches/` directory (e.g., `@univerjs/engine-render`, `exceljs`).

## Testing

- Each package with testable logic has a `tests/` directory using Vitest.
- `pnpm -r test` runs all tests across packages with coverage enabled where configured.
  `apps/admin` has a small Vitest suite (happy-dom) for pure logic and the trend chart; full-page
  behaviour is covered by manual smoke plus the backend contract tests.
- The Java control plane runs `./mvnw test`; `ControlPlaneApiTest` uses Testcontainers (MySQL 8.4,
  Redis 7, RustFS) and covers auth, sync, hosts, channels, the LLM gateway, storage,
  automations and the admin surface.
- Coverage thresholds are configured per-package in `vitest.config.ts`.
- **ACP end-to-end**: `apps/host-node/tests/server.test.ts` drives a full
  `start → new_session → prompt (permission answer) → stop` round trip against a mock agent over
  JSON-RPC stdio, covering the host side of the ACP surface on the HTTP command face.

## Headless Host (`apps/host-node`)

A single-user, self-hosted web host for GreyWork, and the only host implementation — the former Rust
`greywork-host` domain logic was ported module by module (see `docs/node-backend-migration.md`). The
Node host adds the HTTP/WS shell, built-in login and the server-side security policy; it carries no
GUI-toolkit dependency.

### Reuse boundary

The command face has one source of truth: `apps/host-node/src/command-manifest.json` (frozen
metadata snapshot) and `src/commands.ts` `dispatch(name, args, ctx)`; the server routes
`POST /api/command` into `dispatch`.
Commands marked `desktop_only` are rejected server-side and are implemented by the Electron main
process instead — the mirror list in `apps/electron/src/shared/desktop-only.ts` is asserted against
`/api/commands` so the two sides cannot drift (the Electron shell's own unit tests pin its shape).

### Configuration

Loaded from defaults plus `GREYWORK_*` env vars — there is no config file. Fields (`HostConfig` in
`apps/host-node/src/config.ts`): `GREYWORK_BIND` (`host:port`), `GREYWORK_DATA_DIR`,
`GREYWORK_STATIC_DIR` (see [Static hosting](#static-hosting-spa)), password hash / password, session
TTL, `GREYWORK_SECURE_COOKIE`, `GREYWORK_TRUSTED_HOST`, `GREYWORK_ALLOWED_ORIGINS`,
`GREYWORK_WORKSPACE_ROOTS`, `GREYWORK_AGENT_PROGRAMS` and `GREYWORK_EXIT_ON_STDIN_EOF`.

Password bootstrap, in priority order:

1. `GREYWORK_PASSWORD_HASH` — an argon2 PHC string.
2. `GREYWORK_PASSWORD` — plaintext, hashed in memory at startup (dev convenience).
3. Otherwise login is fail-closed: every attempt is rejected and the host prints a warning at
   startup. (The Rust host generated and persisted a random password in `auth.json`; the Node host
   deliberately does not.)

`host-node hash-password` prints an argon2 PHC string from stdin.

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
base64 attachments exceed the 2 MB default most body parsers apply). The WebSocket carries the same event names the
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
- **Static routes are unauthenticated by construction** — auth is checked per API handler, and the
  static routes never call it (the login page must load before login).
- **No static compression.** The Node host streams files as-is — there is no gzip / brotli layer, so
  hashed bundles ship uncompressed. API responses (including 32 MB binary reads) are never
  compressed either, and CORS stays deliberately absent (same-origin deployment).
- **Cache-Control interaction.** Static responses set their own per-path policy (`static-site.ts`);
  API responses always send `no-store` — command results may contain file contents and credentials.

### Security headers

Every response (API and static alike) carries a fixed set of headers from `securityHeaders()` in
`apps/host-node/src/server.ts`, computed once from the config at startup:

| Header                      | Value                                                                 | Why                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | a strict same-origin policy (the fixed directive list in `server.ts`) | the desktop shell loads the same served SPA and inherits this policy — there is deliberately no second, shell-specific CSP                      |
| `X-Frame-Options`           | `DENY`                                                                | clickjacking guard for older browsers (`frame-ancestors 'none'` covers modern ones)                                                             |
| `Referrer-Policy`           | `no-referrer`                                                         | never leak the self-hosted URL/paths to outbound links                                                                                          |
| `Permissions-Policy`        | `camera=(), microphone=(), geolocation=()` (omits `clipboard-*`)      | the UI uses `navigator.clipboard` for its copy buttons, so `clipboard-*` is deliberately left unset; everything else is unused and denied       |
| `X-Content-Type-Options`    | `nosniff`                                                             | don't let the browser sniff JSON/binary into an executable type                                                                                 |
| `Strict-Transport-Security` | `max-age=31536000`                                                    | **only when `secure_cookie` is set** — that flag is the "behind a TLS proxy" signal; over plain HTTP HSTS is meaningless and can lock users out |

There is no `GREYWORK_FRAME_ORIGINS` knob in the Node host: its CSP is same-origin only. Cloud Office
viewers are embedded by the desktop shell, whose static CSP allow-lists the vendor document domains
(`apps/host-node/src/office.ts`); extending the headless policy is tracked by the CSP TODO in
`server.ts`.

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

The server is packaged as a multi-stage image: `node:22-bookworm-slim` builds the SPA, a second
Node stage builds `apps/host-node` (incl. the native `node-pty`) and `pnpm deploy`s a standalone
directory (dist + production deps), and the runtime stage (also `node:22-bookworm-slim`) carries
the host plus `git`/`ca-certificates`/LibreOffice. The frozen agent allow-list resolves against
whatever the operator installs in a derived image and declares via `GREYWORK_AGENT_PROGRAMS`.
The health check probes `/api/health` directly (no `curl`/`wget` in the image).

`docker-compose.yml` publishes `8787`, mounts a named `/data` volume, sets
`no-new-privileges`, and runs as uid 10001. The server itself does no TLS, so production belongs
behind a TLS reverse proxy (Caddy / nginx / Traefik) with `GREYWORK_SECURE_COOKIE=1`; binding
non-loopback without it logs a cleartext-credential warning at startup. See [`docs/packaging.md`](./packaging.md) for the
deployment guide, volume layout, password strategies, and the full capability trade-off matrix.

### Security model

The **authentication boundary is the security boundary**: a valid session can spawn agent
processes, so the controls below limit what the _web UI_ can be tricked into doing.

- **Frozen agent allow-list.** On a network-exposed (untrusted) host, `acp_start` resolves its
  extra allowed programs only from the server config (`GREYWORK_AGENT_PROGRAMS`), never from
  `db.enabled_agent_programs()` — that table is client-writable and would otherwise let a request
  widen the spawn surface. `db_agents_sync` is rejected outright (`403`). A trusted local host
  (`GREYWORK_TRUSTED_HOST=1`, i.e. the Electron sidecar) additionally merges the enabled agent
  provider programs from the DB, since the UI there is the operator's own desktop.
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

GitHub Actions workflows live in `.github/workflows/` and share one composite action
(`.github/actions/setup-node`) so the Node/pnpm/cache policy has a single home.

`ci.yml` runs on push to `master`/`main` and on every PR:

1. **Lint / Typecheck / Test / Build (renderer)** — four parallel jobs mirroring the pre-push hook;
   running them concurrently keeps the wall clock at the slowest job instead of the sum. The build
   job also runs `scripts/front-bundle-guard.mjs` against the emitted bundles.
2. **Renderer smoke (e2e)** — installs headless Chromium and drives the web and desktop preview
   chains (`pnpm --filter @greywork/web e2e`, `pnpm --filter @greywork/desktop e2e`).
3. **Electron Bundle** — three-platform matrix that builds the bundled runtimes, the host, the
   renderer SPA and the shell (`pnpm electron:prep`), runs the shell unit tests, then packages an
   unpacked app with electron-builder. Actual installers are produced by `release.yml` (see below).

Host tests run inside `pnpm -r test` (including the ACP round trip and the sheet parser against a
legacy `.xls` fixture).

Caches: pnpm store via the `setup-node` composite; bundled runtimes keyed on
`scripts/runtime-versions.json`.

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
shared with the Electron / bundled-runtime caches.

## Native model agent loop (`apps/host-node/src/llm-agent.ts`)

Three conversation paths share one OpenAI-compatible transport (`apps/host-node/src/llm.ts`) and
differ only in what they declare to the model:

| Path             | Entry             | Tools                                | Where the loop lives                     |
| ---------------- | ----------------- | ------------------------------------ | ---------------------------------------- |
| Single-turn chat | `llm_chat_start`  | none                                 | one request                              |
| **Native agent** | `llm_agent_start` | `read_file` / `list_dir` / `git_log` | host (`apps/host-node/src/llm-agent.ts`) |
| ACP agent        | `acp_send`        | whatever the external agent declares | external process                         |

### Why the loop runs in the host

The tool surface is read-only, so every call is auto-approved under all three permission tiers —
no interactive confirmation branch exists. That is what lets the loop live in the host: the
renderer and the remote-assistant pipeline (`stores/remote-assistant/pipeline.ts`) drive the same
`llm_agent_start` command, and aborting is `AbortController.abort()` exactly as in `llm_chat_stop`.

### Trust boundary

Tools execute **inside GreyWork, inside its own authorization surface** — `read_file` /
`list_dir` go through the same `workspace-access.ts` resolution as the `fs_read_text_file` /
`fs_list_dir` commands, and `git_log` calls the same `git_log`. There is deliberately **no second
allow-list**:
a path outside the authorized roots fails in `resolveExisting`, which canonicalizes _before_
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

Two read caps live in the host, not the renderer (`apps/host-node/src/workspace-access.ts`):
`MAX_BINARY_BYTES` = 20 MB for `fs_read_binary`, and `MAX_MEDIA_BYTES` = 128 MB for
`fs_read_media`. `fs_read_media` clamps a caller-supplied `maxBytes` to its own ceiling, so the
renderer can ask for a per-kind budget but can never raise the host's hard cap. Both are **errors**
when exceeded, never truncation — a half file surfaces as "corrupt format", which is far harder to
diagnose than a size message.

### Office preview: native vs. high-fidelity (LibreOffice)

Office documents have **two** rendering paths, chosen per tab by a viewer-level switch
(`OfficeViewSwitch`, shown only for covered kinds):

- **Native** (`docx` → `DocViewer`, `pptx` → `SlideViewer`, `legacy-office` → `LegacyOfficeViewer`):
  in-house OOXML parsers. They re-flow to panel width and support in-place text editing, but have
  known fidelity gaps (headers/footers, columns, page breaks, footnotes, fields, floating objects).
- **High-fidelity (PDF)**: the host runs LibreOffice headless (`soffice --convert-to pdf`, service in
  `apps/host-node/src/office.ts`) and the renderer feeds the bytes to the
  existing `PdfViewer`. This closes the fidelity gaps but is read-only.

**Priority** in `PreviewSurface.vue`: a configured cloud Office provider wins (user opted into a
third-party service); otherwise a covered kind defaults to high-fidelity **iff** the host reports
LibreOffice available (`office_convert_info`), else native. Any conversion failure falls back to the
native viewer **with** a notice — never a silent dead end.

The converter is the B driver layer (on-demand external tool), **not** an embedded engine: it is
invoked only when a user opens an office file with LibreOffice present, returns PDF bytes via the
`office_convert_to_pdf` binary command, and cleans up its scratch profile per run. Spreadsheet kinds
(`xlsx`/`xls`) are deliberately excluded — converting them to PDF throws away Univer's interactive
table and analysis views for a static print layout.

### Media playback: stream, don't buffer

Reading a video into memory and handing `<video>` a `blob:` URL does **not** work for real files:
the IPC transfer plus the synchronous `new Blob` copy freeze the renderer, and WebKit buffers the
whole blob before it starts playing (seeking is effectively broken). The symptom is a spinner with
no error anywhere.

So both hosts stream: the server exposes `GET /api/media?path=…` with **HTTP Range** support
(served by the host's static/media route), serving 1 MB chunks. The slice logic
(`readMediaSlice`, which also owns the MIME table) authorizes through
`WorkspaceAccess.resolveExisting` (`apps/host-node/src/workspace-access.ts`) — the _same_ check
`fs_read_media` uses, so there is no second
allow-list to keep in sync. `packages/host-ipc/src/media.ts` returns that same-origin address in
server mode (which is what the Electron shell runs), so `lib/preview-content.ts`
(`resolvePreviewMedia`) gets a stream everywhere a host exists and only browser-preview mode falls
back to bytes. Same-origin media is covered by `default-src 'self'` in the host CSP.

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

### CAD: DXF in, DWG out

`DxfViewer.vue` previews ASCII DXF with a plain 2D canvas (no WebGL). `lib/dxf.ts` normalizes
LINE / LWPOLYLINE / POLYLINE (including bulge arcs) / CIRCLE / ARC / ELLIPSE / SPLINE (fit or
control points) / TEXT / MTEXT / POINT / SOLID / 3DFACE / INSERT / DIMENSION into polylines, texts
and dots; block references are expanded with translation / rotation / scale (depth-capped), and the
total point count is capped at 200k so a site plan cannot freeze the renderer. The viewer owns the
viewport: wheel zoom anchored at the cursor, drag pan, zoom buttons and fit-to-extent. Re-exporting
the file resets the viewport because the drawing extents usually change.

DWG / DWF are proprietary binary containers with no pure-JS decoder. They map to `legacy-cad`, which
states that explicitly and offers "open with system app" (or save a DXF copy). Do **not** route them
to `raw`: binary decoded as UTF-8 is mojibake with no error.

## Design Principles

- **Thin host, Fat TypeScript**: UI and orchestration logic live in TS; the Node host provides the command surface, process hosting, and system access. Agents keep their own permission models — the host no longer sandboxes them at the OS level.
- **Shared Workbench**: Desktop and web share a single UI package to maximize code reuse.
- **Plugin System**: Uses Cordis micro-kernel for plugin lifecycle; skills are vendored in `.agents/skills/`.
- **Clipboard goes through the host**: the facade exposes `hostClipboard()` (Electron main-process `clipboard` / browser Web API), because some renderers silently resolved the Web Clipboard API without writing (see ESLint rule in `eslint.config.js`).
