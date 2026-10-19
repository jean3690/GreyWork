# GreyWork Packaging & Distribution

How the desktop app is packaged (Electron), and what is still missing before
signed installers can ship.

## In-app update check (no signed auto-update)

The app does **not** bundle an in-place updater: no signed updater chain, no `latest.json`.
A signed updater needs a private key held as a repo secret and a manifest merged race-free
across parallel release jobs; we opted to keep the release pipeline key-free.

What the titlebar "Check for updates" does instead (`lib/update-backend.ts` + the shared
`check_update` command in `crates/greywork-host/src/services/update.rs`):

- Calls the GitHub Releases API (`/releases/latest`) from the **host** (the headless server
  the shell spawned), which compares `tag_name` with the running version and shows the
  release notes.
- "Go to download" opens the release page in the system browser via `open_external`
  (http/https only). Every platform takes this same manual path.

No repo secrets are required to build or release.

## Code signing & notarization — not wired up yet

Deliberately left out: both require certificates we do not have, and wiring the
steps up without the secrets only turns a working workflow into a failing one.
What each side needs (electron-builder reads these from env vars on the runner):

**macOS** — an Apple Developer Program membership and a _Developer ID Application_
certificate.

1. Export the cert as `.p12`, base64 it into the `CSC_LINK` secret (with
   `CSC_KEY_PASSWORD` if passphrase-protected); electron-builder imports it on the runner.
2. For notarization set `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and
   `APPLE_TEAM_ID` — electron-builder notarizes the notarized app automatically.

Until then, Gatekeeper quarantines the downloaded `.dmg`. Users can right-click →
Open, or run `xattr -dr com.apple.quarantine /Applications/GreyWork.app`.

**Windows** — an OV or EV code-signing certificate (EV avoids the SmartScreen
reputation warm-up).

1. Set `CSC_LINK` (a `.pfx` in a secret) + `CSC_KEY_PASSWORD`; electron-builder runs
   signtool with a `sha256` digest and a default timestamp server.
2. EV certificates on hardware tokens need a cloud signing service instead of a
   `.pfx` in a secret (electron-builder supports `sign`/`signOptions` hooks).

Until then, SmartScreen warns on the unsigned NSIS installer.

## Building locally

```sh
pnpm electron:package        # sidecar（release）+ 渲染层 + 壳 + electron-builder
pnpm --filter @greywork/electron package:dir    # 只出未压缩目录（快，用于本地验证）
```

Artifacts land in `apps/electron/release/<version>/`（安装包 + `<name>-unpacked/`）。

## Browser front (`apps/web`)

`apps/web` is a second frontend built from the same `@greywork/workbench` sources with a narrower
`FrontSpec` (see [architecture.md](architecture.md#frontends-appsdesktop--appsweb)). It is a static
SPA: no Electron, no native shell.

```sh
pnpm dev:web        # Vite dev server on 1421 (proxies /api to 127.0.0.1:8787)
pnpm build:web      # → apps/web/dist
```

Deployment requirements:

- Serve `apps/web/dist` as the site root. The router uses **hash history**, so no rewrite rules are
  needed for client-side routes.
- Reverse-proxy `/api/*` (including the `/api/events` WebSocket upgrade) to `greywork-server` on the
  **same origin**. The server does not send CORS headers and the login cookie is scoped to the front
  origin, so a cross-origin split would break authentication.
- `/pdfjs/*` and `/vscode-icons/*` are absolute runtime paths baked into the workbench sources; the
  web build emits them at the root (`emitsSharedAssets: true`). If you put the SPA under a sub-path,
  those assets must still be reachable at the root.

Against a headless server the browser front is a full client for conversations, automation and the
plugin market. Capabilities that need a local host (installing skills, native dialogs, system tray)
degrade with an explicit message rather than failing silently.

## Desktop installers (Electron)

The desktop app is an **Electron** app (`apps/electron`). The shell only spawns the headless
`greywork-server` as a sidecar and loads the **same renderer build** (`apps/desktop/dist`) from
it — no second copy of the domain logic, no separate frontend build.

The sidecar listens on a **stable loopback port** (persisted in `userData/sidecar-port.json`,
default `17844`, bumped only on collision). This is load-bearing, not cosmetic: the renderer
persists the workspace list, sessions, settings and layout in `localStorage`, which browsers key
by **origin** (scheme + host + _port_). A random per-launch port would mint a fresh, empty origin
on every start — the user-visible symptom is "my workspaces/settings disappear every launch".

Build order matters (the root script `pnpm electron:package` chains it all):

```sh
cargo build --release -p greywork-server     # sidecar binary      → target/release/
pnpm --filter @greywork/desktop build        # renderer SPA        → apps/desktop/dist/
pnpm --filter @greywork/electron build       # main + preload      → apps/electron/out/
pnpm --filter @greywork/electron package     # electron-builder    → apps/electron/release/<version>/
```

`apps/electron/electron-builder.yml` decides what lands where:

| Location               | Contents                                       | Why                                         |
| ---------------------- | ---------------------------------------------- | ------------------------------------------- |
| asar (`files: out/**`) | main process + preload only                    | the real SPA is served by the sidecar       |
| `resources/static/`    | the renderer SPA (`apps/desktop/dist`)         | becomes the sidecar's `GREYWORK_STATIC_DIR` |
| `resources/server/`    | the `greywork-server` binary for that platform | spawned as a sidecar on launch              |
| `resources/icons/`     | tray icon + installer icons                    | runtime + per-platform installer icons      |

Targets: Linux `AppImage`, Windows `nsis`, macOS `dmg`. CI builds with `--dir` (unpacked) only:
the per-platform installers pull extra tooling at build time, which is flaky on CI runners —
actual installers are produced in `release.yml` and attached to the draft Release.

`pnpm version:sync` keeps the version in the root `package.json`, `apps/desktop` and
`apps/electron` in step — electron-builder reads the shell's own `package.json`, so drift shows
up as an installer whose version does not match the release tag.

## Windows development prerequisites

- Rust with the **MSVC** toolchain (`stable-x86_64-pc-windows-msvc`), Node 20+ and
  pnpm.
- **MSVC Build Tools with "Desktop development with C++"** are required even though
  this is a Rust project: `rusqlite` is pulled in with the `bundled` feature, so
  `libsqlite3-sys` compiles SQLite from C source through the `cc` crate. A fresh
  clone without the C++ workload fails in `libsqlite3-sys`'s build script.
- No OpenSSL needed: `reqwest` and `tokio-tungstenite` are both configured with
  rustls (`rustls-tls` / `rustls-tls-webpki-roots`), which vendors its own crypto.
- WebView2 ships with Windows 10+; on older images install the Evergreen Runtime.

## Self-hosting the web server (Docker)

The headless server (`apps/server`, see [architecture.md](architecture.md#headless-server-appsserver))
ships the same Vue renderer as a same-origin SPA behind a password login. A multi-stage
[`Dockerfile`](../Dockerfile) at the repo root builds it:

1. **web** (`node:22`) runs `pnpm build:desktop` → `apps/desktop/dist` (only the front this image
   serves; `apps/web` is a separate deployment). The build context has no `~/.npmrc`, so it uses the
   public npm registry; pass `--build-arg NPM_REGISTRY=https://registry.npmmirror.com` (or your own
   mirror) if you are behind a slow link to npmjs — otherwise pnpm's metadata requests time out
   mid-install.
2. **server** (`rust:1`) runs `cargo build --release -p greywork-server` — only the server crate and
   `greywork-host`, so no GUI toolkit deps are pulled. `cmake` is installed for `aws-lc-rs`
   (rustls); `rusqlite` compiles bundled SQLite with the base image's C toolchain.
3. **runtime** (`debian:bookworm-slim`) carries just the binary, the built SPA at `/app/web`,
   `ca-certificates` and `git`. It runs as a non-root user and serves `0.0.0.0:8787`.
   **LibreOffice** (`libreoffice-writer` + `libreoffice-impress`, plus `fonts-noto-cjk` for CJK
   glyphs) is also installed here so the "high-fidelity (PDF)" office preview works out of the box;
   `soffice` is on `PATH`, so no `GREYWORK_SOFFICE_PATH` is needed in the default image.

```sh
# 0) 可选：cp .env.example .env —— 三种密码来源 / 授权面 / 安全开关 / 自动化任务与
#    模型凭证都在里面逐条注明了用途
cp .env.example .env

# 1) 生成登录密码哈希（argon2 PHC 串），填进 .env
docker compose run --rm greywork hash-password
echo 'GREYWORK_PASSWORD_HASH=<paste>' >> .env

# 2) 起服务
docker compose up -d --build

# 3) 浏览器打开 http://<host>:8787 登录
```

Key environment variables (full list: `greywork-server help`):

| Variable                           | Purpose                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GREYWORK_PASSWORD_HASH`           | argon2 PHC login password (best source). Else `auth.json` / `GREYWORK_PASSWORD`.                |
| `GREYWORK_WORKSPACE_ROOTS`         | Colon-separated container paths the agent may touch (`fs_*` / `git_*`).                         |
| `GREYWORK_SECURE_COOKIE`           | `1` behind a TLS reverse proxy (adds `Secure` to the session cookie).                           |
| `GREYWORK_AGENT_PROGRAMS`          | Extra allowed agent programs (frozen allow-list; DB is never trusted).                          |
| `GREYWORK_STATIC_DIR`              | SPA dir; the image sets `/app/web`. Missing `index.html` → hard startup failure.                |
| `GREYWORK_FRAME_ORIGINS`           | Comma-separated origins allowed in the CSP `frame-src` (cloud Office viewers).                  |
| `GREYWORK_AUTOMATION_HOST_PRIMARY` | `1` = the server **is** the automation executor (see below).                                    |
| `GREYWORK_TRUSTED_HOST`            | `1` = client is on this machine (Electron sidecar). Lifts three fail-closed clamps — see below. |

Design/security notes:

- **No built-in TLS.** Put the container behind a TLS-terminating reverse proxy (Caddy / nginx /
  Traefik) and set `GREYWORK_SECURE_COOKIE=1`. Binding a non-loopback address without `secure_cookie`
  logs a startup warning — the password and session token would otherwise cross the wire in clear.
- **Health probe is self-contained.** `HEALTHCHECK` runs `greywork-server healthcheck` (a raw TCP GET
  to `/api/health`); the image ships no `curl`/`wget`, keeping the runtime tool surface minimal.
- **`GREYWORK_TRUSTED_HOST` is the one control that widens the client's reach — treat it as a
  deployment-mode switch, not a convenience flag.** Defaults are fail-closed because the client is
  assumed to be _remote_; a trusted host means the client runs on the same machine and is
  authoritative. Setting it lifts three fail-closed clamps at once:
  1. **ACP `tier` stops being pinned** (`GREYWORK_TIER`, default `read-only`). Normally the server
     overwrites that field on `acp_start` and `acp_set_permission_tier`, so a remote session can
     neither escalate its tier nor run repo scripts through `worktree_provision`. Unpinned, the tier
     the user picked in the UI is what actually runs, and `sys_info` reports `pinnedTier: null` —
     which is what re-enables the pickers in Settings.
  2. **`db_agents_sync` is allowed.** It is the source of truth for the agent-backend directory and
     can write an arbitrary `command`; when denied (the default) the UI greys out the whole agent
     directory as read-only.
  3. **`acp_start` reads the DB-enabled backends** instead of only the frozen `GREYWORK_AGENT_PROGRAMS`
     list, so a backend the user just added works without a restart.
  4. **`fs_authorize_drop_paths` / `fs_authorize_picked_paths` are allowed.** The renderer gets an
     absolute path from an OS drop (`webUtils.getPathForFile`) or from the shell's own native dialog
     but the host has no idea the user did anything, so it must declare the path explicitly —
     otherwise the following `fs_read_*` is refused with "path not authorized". Drops authorize
     files only (a dropped folder must not hand over a whole tree); picked paths authorize files
     **and** directories, since picking a folder is how a workspace root gets bound.

  The Electron desktop shell runs this server as its own private backend on loopback and therefore
  sets `GREYWORK_TRUSTED_HOST=1`. **Never set it on a network-exposed deployment** — a non-loopback
  bind with this flag on logs a loud startup warning, because it hands any client on the network the
  ability to pick its own permission tier and rewrite the agent-backend directory.

- **Security headers.** The server sends a strict `Content-Security-Policy` (also governing the
  desktop shell, which loads the same served SPA; `media-src 'self' blob:` — `blob:` is for inbound video/voice thumbnails and
  browser-preview mode; workspace video/audio streams through the same-origin `/api/media` route), `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera / microphone / geolocation / … all
  denied; `clipboard-*` is deliberately left alone because the UI's copy buttons use
  `navigator.clipboard`) and `X-Content-Type-Options: nosniff` on every response. `HSTS` is sent
  **only** when `GREYWORK_SECURE_COOKIE=1` — that flag is the "there is a TLS proxy in front" signal,
  and over plain HTTP the header is meaningless (it can even lock users out).
  `GREYWORK_FRAME_ORIGINS` **only** appends a `frame-src` directive — it cannot relax the rest of the
  policy, and entries that are not a bare `scheme://host[:port]` are dropped with a startup warning
  (anything containing `;`, quotes, wildcards or whitespace could otherwise rewrite the policy).
  This is what makes a _custom_ cloud-Office vendor usable — the Electron shell loads the same
  served SPA, so it inherits this server-side policy instead of carrying its own.
  The policy is verified against the **real** hosted bundle by `pnpm --filter @greywork/desktop
e2e:served`, which logs in and opens markdown / HTML / PDF / xlsx previews while asserting zero
  `securitypolicyviolation` events — dev-server CSP is a different beast, so only the served build
  counts.
- **Hardened by default.** `docker-compose.yml` sets `no-new-privileges` (so neither the server nor
  any agent child can gain privileges via setuid) and runs as uid 10001. Agents run unsandboxed —
  they keep their own permission models (see the sandbox note in architecture.md).
- **Unattended automations.** Scheduled tasks live in the **server's** database — a task created in
  the desktop app is not visible here (and vice-versa). To have a task run without any browser or
  desktop machine being open, create it in the server's web UI and set
  `GREYWORK_AUTOMATION_HOST_PRIMARY=1`; the ticker then claims due runs immediately instead of
  waiting out the 2-minute "renderer is probably busy" grace window that the desktop shell uses.
  Both roles go through the same row-level atomic claim, so a renderer that _is_ attached will never
  double-run a task it already handed over.
  Unattended runs go straight to the model provider from `settings.modelProviders` — the API key is
  read from **this process's** environment via `apiKeyEnv`, so inject it into the container
  (e.g. `-e OPENAI_API_KEY=…` / `.env`) or the run fails with "no usable model config". Tasks bound
  to an ACP backend are deliberately **not** executed host-side: swapping executors would silently
  change what the task does. Their runs are recorded as failed and picked up by the next cron window
  while an app is attached.
- **Agent runtimes are not bundled.** Add `node` / `python3` / `uvx` etc. in a derived image and list
  them in `GREYWORK_AGENT_PROGRAMS` if you need those ACP backends.
