# GreyWork

**English** | [简体中文](README-zh.md)

[![CI](https://github.com/jean3690/GreyWork/actions/workflows/ci.yml/badge.svg)](https://github.com/jean3690/GreyWork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB)
![Vue 3](https://img.shields.io/badge/Vue-3-42B883)

A desktop-first AI agent workspace for developers who think in code, diagrams, and multi-agent workflows.

GreyWork puts external coding agents (via the **Agent Client Protocol**) and local OpenAI-compatible
models behind one workbench: conversations with tool timelines and permission gates, an authorized
workspace with file preview and Git, a plugin / MCP / skills market, scheduled tasks, and seven
messaging channels so you can drive the machine from your phone.

## Features

**Agent runtime**

- ACP (Agent Client Protocol) backends — connect external agents, manage sessions, and declare MCP
  servers to them; per-session config options (model / reasoning effort / session mode) are probed
  from the backend and can be overridden.
- Local model pipeline — OpenAI-compatible streaming providers with custom request headers
  (`{{ENV}}` placeholders supported) and reasoning-effort control.
- Permission model — three tiers (read-only / workspace / full access), host-side interception of
  out-of-workspace and write-in-read-only operations, per-kind "always allow" memory scoped to a
  session, and a read-only **permission trace** left in the message stream explaining what was
  approved, by whom, and why.

**Workspace**

- Authorized workspace root: every file, Git, and process operation is scoped to the resolved root.
- File preview for text (CodeMirror 6, many languages), Markdown, CSV, images, PDF, and office
  documents; preview panel with tab drag-reorder, middle-click close, and async skeleton loading.
- Git surfaced through the host CLI, strictly inside the workspace.

**Extensibility**

- Plugin runtime on a Cordis micro-kernel with capability grants; declarative plugins are restricted
  JSON and never execute remote JavaScript.
- **Market** in one place: the official plugin registry (signed, so a compromised GitHub account
  cannot poison the catalog), the MCP registry, and skill sources such as skills.sh.
- Agent skills vendored under `.agents/skills/`, locked with hashes in `skills-lock.json`.

**Beyond the conversation**

- Scheduled tasks — cron or one-shot triggers, plus AI-proposed schedules the model emits as a
  `schedule` fence that you confirm before anything is created.
- Remote assistants — WeChat (ClawBot / iLink), DingTalk, Feishu, Telegram, QQ, Discord, and WeCom;
  credentials live in the local app data directory (0600) and never enter settings snapshots.
- Team / cowork sessions — multiple members on one task, each with their own ACP session config.
- Activity panel for artifacts produced during a session.

**Platform**

- Tauri 2 desktop shell (Linux / macOS / Windows), Rust host, Vue 3 renderer.
- Bilingual UI (zh-CN / en-US); host capabilities degrade gracefully when the UI runs in a browser.

## Tech Stack

| Layer   | Choices                                                                     |
| ------- | --------------------------------------------------------------------------- |
| Desktop | Tauri 2, Rust, rusqlite, tokio, reqwest, `agent-client-protocol`            |
| UI      | Vue 3, Vite, Pinia, vue-router, vue-i18n, Tailwind, shadcn-vue (reka-ui)    |
| Editing | CodeMirror 6, Univer (spreadsheets / docs)                                  |
| Plugins | Cordis micro-kernel                                                         |
| Tooling | pnpm workspaces, TypeScript, Vitest (node + dom projects), ESLint, Prettier |

## Project Structure

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
│   ├── plugins/              # Plugin market adapters & types
│   ├── cowork/               # Co-operative workspace engine
│   └── workbench/            # Unified UI package (shell, views, plugin runtime)
├── plugin-market/            # Plugin registry source + signing
├── .agents/skills/           # Installed agent skills (vendored)
└── skills-lock.json          # Locked skill definitions with hashes
```

Dependency direction is enforced by ESLint: leaf packages depend only on `@greywork/core` (or
nothing), `workbench` composes them, and nothing in `packages/` may import from `apps/`.

See [docs/architecture.md](docs/architecture.md) for the full dependency graph and host domains.

## Quick Start

```bash
# Prerequisites
#   Node >= 20, pnpm >= 9 (corepack recommended)
#   Rust stable + platform Tauri deps (only for the desktop shell)

git clone https://github.com/jean3690/GreyWork.git
cd GreyWork
pnpm install
pnpm dev        # Vite dev server + Tauri window
```

On Wayland, `pnpm tauri:wayland` sets the required environment variables.

## Common Commands

| Command            | Description                                      |
| ------------------ | ------------------------------------------------ |
| `pnpm dev`         | Start the desktop dev environment (Vite + Tauri) |
| `pnpm lint`        | ESLint across the repo                           |
| `pnpm format`      | Format with Prettier (`format:check` to verify)  |
| `pnpm typecheck`   | TypeScript check across all workspace packages   |
| `pnpm test`        | Vitest across all packages                       |
| `pnpm build`       | Build the desktop renderer                       |
| `pnpm tauri build` | Build the full Tauri bundle                      |
| `pnpm check`       | `typecheck` + `build`                            |

Rust side (run inside `apps/desktop/src-tauri`): `cargo fmt`, `cargo clippy -- -D warnings`,
`cargo test`.

## Testing & CI

- Vitest runs in two projects — `node` for pure logic and `dom` for component behavior; coverage
  thresholds are configured per package.
- `.github/workflows/ci.yml` mirrors the local hooks: ESLint → Prettier check → typecheck → tests →
  build, plus `cargo fmt` → `cargo clippy` → `cargo test`.
- Tagging `v*` runs `.github/workflows/release.yml`, which builds deb / NSIS / dmg bundles and opens
  a draft GitHub Release. The release body is taken from the matching entry in
  [CHANGELOG.md](CHANGELOG.md); un-draft it once all three platforms are green.
- A pre-push hook runs `pnpm lint && pnpm -r test`, so a broken push fails locally first.

## Security Model

GreyWork treats the renderer as untrusted with respect to the native host:

- Declarative plugin packages are restricted JSON — they cannot execute remote JavaScript.
- Plugin capability grants are explicit and checked at the host boundary.
- Workspace root authorization scopes file, Git, and process execution.
- Free-form process execution is guarded and sandboxed.
- Channel and provider credentials are stored with `0600` permissions in the app data directory and
  are excluded from settings snapshots.
- A strict CSP is configured for the Tauri window.

## Contributing

Commit conventions, hooks, and the review workflow are documented in
[.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) (Chinese). UI changes must come with a manual
verification note; architecture and design decisions belong in
[docs/architecture.md](docs/architecture.md) and [docs/ui-design.md](docs/ui-design.md).

## License

[MIT](LICENSE)
