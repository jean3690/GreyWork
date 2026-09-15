# GreyWork

A desktop-first AI agent workspace for developers who think in code, diagrams, and multi-agent workflows.

Built as a **pnpm monorepo** with:

- **Tauri desktop shell** (`apps/desktop`) — Vite + Vue renderer over a Rust host
- **9 TypeScript packages** (`packages/*`) — shared domain packages and a unified workbench UI
- **Agent skills** (`.agents/skills/`) — vendored AI agent skill definitions

## Quick Start

```bash
# Prerequisites
# Node >= 20, pnpm >= 9 (corepack recommended), Rust stable (for Tauri)

git clone <this-repo>
cd greyWork
pnpm install
pnpm dev        # starts desktop dev server + Tauri window
```

## Development

| Command            | Description                                  |
| ------------------ | -------------------------------------------- |
| `pnpm dev`         | Start desktop dev environment (Vite + Tauri) |
| `pnpm lint`        | Run ESLint across all packages               |
| `pnpm format`      | Format code with Prettier                    |
| `pnpm typecheck`   | Run TypeScript type checking                 |
| `pnpm test`        | Run all tests across packages                |
| `pnpm build`       | Build desktop renderer                       |
| `pnpm tauri build` | Build full Tauri bundle                      |

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) for commit conventions, CI gates, and development workflow.

## Project Structure

- `packages/core/` — Shared types & math utilities (zero dependencies)
- `packages/editor/` — File system, Git, CodeMirror abstractions
- `packages/agents/` — AI agent domain logic (roles, orchestration)
- `packages/llm/` — LLM provider clients (OpenAI-compatible streaming)
- `packages/acp/` — Agent Client Protocol client
- `packages/shell/` — Provider registry & data plane transports
- `packages/plugins/` — Plugin market adapters & types
- `packages/cowork/` — Co-operative workspace engine
- `packages/workbench/` — Unified UI package (desktop + web)
- `apps/desktop/` — Tauri application shell

See [docs/architecture.md](docs/architecture.md) for the full architecture and dependency graph.

## Design

UI guidelines and design tokens are documented in [docs/ui-design.md](docs/ui-design.md). The canonical implementation lives in `@greywork/workbench/src/theme/`.

## License

[MIT](LICENSE)
