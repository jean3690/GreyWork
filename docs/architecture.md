# GreyWork Architecture

GreyWork is a monorepo implementing a desktop-first AI agent application. It uses pnpm workspaces with TypeScript packages in `packages/` and a Tauri desktop shell in `apps/desktop/`, backed by Rust for the native host.

## Monorepo Layout

```
greyWork/
├── apps/
│   └── desktop/              # Tauri shell: Vite + Vue renderer + Rust host
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
- Rust host code lives in `apps/desktop/src-tauri/src/`. Major host domains: `llm.rs` (OpenAI-compatible stream -> IPC), `acp_host.rs`, `mcp*.rs`, `host_exec.rs` (sandboxed process exec), `http.rs` / `web_fetch.rs`, `workspace_fs.rs` (authorized workspace root resolution) and `git.rs` (git CLI surfaced as `git_*` commands, scoped to the authorized root).
- Patches are applied to dependencies via `patches/` directory (e.g., `@univerjs/engine-render`, `exceljs`).

## Testing

- Each package with testable logic has a `tests/` directory using Vitest.
- `pnpm -r test` runs all tests across packages with coverage enabled where configured.
- Rust tests run via `cargo test` in `apps/desktop/src-tauri`.
- Coverage thresholds are configured per-package in `vitest.config.ts`.

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
3. **Cargo Test (src-tauri)** — `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`.
   The pre-push hook runs these same three commands, in this order, when a push touches `apps/desktop/src-tauri`.

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
