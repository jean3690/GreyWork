# GreyWork Packaging & Distribution

How the desktop app is bundled for each platform, and what is still missing before
signed installers can ship.

## Bundle targets per platform

`bundle.targets` is overridden per platform through Tauri's platform config files,
which are merged on top of `tauri.conf.json` before validation:

| Platform | Config file                         | `bundle.targets` |
| -------- | ----------------------------------- | ---------------- |
| Linux    | `src-tauri/tauri.linux.conf.json`   | `["deb"]`        |
| Windows  | `src-tauri/tauri.windows.conf.json` | `["nsis"]`       |
| macOS    | `src-tauri/tauri.macos.conf.json`   | `["app", "dmg"]` |

The merge is [RFC 7386](https://datatracker.ietf.org/doc/html/rfc7386) JSON Merge
Patch (`json_patch::merge`): objects merge recursively, arrays are replaced. A
platform file therefore only needs the keys it overrides — `bundle.active` and
`bundle.icon` still come from the base config. `tauri.conf.json` keeps
`"targets": "all"` as the fallback for any platform without an override file.

`tauri build --bundles <list>` replaces the config value entirely, which is why
`ci.yml` and `release.yml` can still pass an explicit `--bundles` per matrix row.

### Why not a single `"targets": ["deb", "nsis", "app", "dmg"]` list

`tauri-bundler` skips targets that were compiled out for the host platform
(`_ => log::warn!("ignoring {}", ...)`) — **except `nsis`**, which is deliberately
not `cfg`-gated so NSIS installers can be cross-built on Linux/macOS via
`cargo-xwin`. Listing `nsis` in the base config would therefore make a plain
`pnpm tauri build` on Linux _attempt_ to produce a Windows installer. Per-platform
files are the only way to express "deb on Linux, nsis on Windows" safely.

The extra targets we drop were also the slowest:

- Linux `appimage` needs `linuxdeploy` downloaded at build time (unstable in CI),
  and `rpm` pulls in another toolchain. `deb` is what we ship.
- Windows `msi` needs WiX; NSIS is smaller and is what we ship.

## Bundle metadata

`category`, `shortDescription`, `longDescription`, `publisher`, `homepage`, `copyright`
and `license` live in the base `tauri.conf.json` because they are platform-neutral
descriptions of the app. Where each one actually ends up is worth writing down, because
the schema's one-line descriptions are easy to over-read. The deb column was verified by
building the package and reading the generated `control` and `.desktop`; the rest is
marked accordingly.

| Key                | deb (verified)                                                   |
| ------------------ | ---------------------------------------------------------------- |
| `category`         | `.desktop` `Categories=Development;` (was empty)                 |
| `shortDescription` | `Description:` first line, and `.desktop` `Comment=`             |
| `longDescription`  | the indented extended description                                |
| `homepage`         | `Homepage:`                                                      |
| `publisher`        | _nothing_ — deb `Maintainer` comes from `Cargo.toml`'s `authors` |
| `copyright`        | _nothing_                                                        |
| `license`          | _nothing_                                                        |

Two of these matter beyond the deb: `tauri-bundler` contains the NSIS metadata strings
`Manufacturer` and `LegalCopyright`, so `publisher` and `copyright` are what the Windows
installer reports to the OS. Neither `LSApplicationCategoryType` nor
`NSHumanReadableCopyright` appears in the bundler at all, so `category` and `copyright`
do **not** reach the macOS `Info.plist`.

`category` also does **not** produce the deb `Section:` field, despite the two looking
like the same concept in the schema. `Section` is a separate key that only exists on
`bundle.linux.deb` — see below.

## Debian package metadata

Three deb-only keys are set in `src-tauri/tauri.linux.conf.json`, because none of them
has an equivalent on the other platforms:

- `linux.deb.section: "devel"` — the `Section:` field, which `bundle.category` does not
  fill in. Without it `apt` has no section to file the package under.
- `linux.deb.depends: ["libc6"]` — **appends** to the dependencies `tauri-bundler`
  computes (`libwebkit2gtk-4.1-0`, `libgtk-3-0`), it does not replace them; the result is
  `libc6, libwebkit2gtk-4.1-0, libgtk-3-0`. Debian Policy 8.6 requires the libc
  dependency, and `lintian` flags its absence as an error.
- `linux.deb.files` — ships `LICENSE` to `/usr/share/doc/grey-work/copyright`. Debian
  Policy 12.5 requires a verbatim copyright file per package; without one `lintian`
  reports `no-copyright-file`. `bundle.licenseFile` is **not** the knob for this: it is
  read only by the NSIS/Windows bundler, and setting it changes nothing in the deb.
  The destination hardcodes the package name (`grey-work`, derived from `productName`),
  so it needs updating if the product is ever renamed.

`lintian` on the resulting `.deb` is clean apart from four tags, all left as-is
deliberately:

| Tag                           | Why it is still open                                                         |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `malformed-contact`           | `Maintainer` needs an RFC 822 `Name <email>`; we have no project address yet |
| `no-changelog`                | Debian expects a `changelog.gz` in Debian's own format, not `CHANGELOG.md`   |
| `unstripped-binary-or-object` | `strip` is not set on the release profile — see below                        |
| `no-manual-page`              | there is no man page                                                         |

The binary ships unstripped because the release profile does not set `strip`. Adding
`strip = true` to `[profile.release]` in `src-tauri/Cargo.toml` would clear that tag and
shrink the download, but it also removes the symbol table from all three platforms'
binaries, which is what makes a panic backtrace readable. That trade-off is a support
decision rather than a packaging one, so it is left open here.

## Windows installer

`bundle.windows.webviewInstallMode` is written out explicitly as
`downloadBootstrapper` (silent) instead of being left implicit. The value matches
Tauri's default — the point is that the decision is visible and has a single place to
change it.

The modes differ only in how much of WebView2 is shipped inside the installer. Read
off `tauri-bundler`'s NSIS implementation (`FixedRuntime` is a separate mechanism — it
ships a runtime as an app resource instead of installing one):

| Mode                                 | Installer size | Internet at install time?                                          |
| ------------------------------------ | -------------- | ------------------------------------------------------------------ |
| `downloadBootstrapper` (what we use) | baseline       | yes — fetches and runs the bootstrapper                            |
| `embedBootstrapper`                  | +1.8 MB        | yes — only the bootstrapper is local, it still fetches the runtime |
| `offlineInstaller`                   | +127 MB        | no — the full runtime is embedded                                  |
| `skip`                               | baseline       | no — and no install attempt at all                                 |

`downloadBootstrapper` was kept because WebView2 is already present on Windows 11 and
on any Windows 10 machine with Edge, so the download only happens on the rare machine
that is missing it. `embedBootstrapper` buys almost nothing: it costs a build-time
download from a Microsoft endpoint while still needing the network at install time.
`offlineInstaller` would multiply the installer size by roughly 7–10× to serve that
same rare case. Switch to `offlineInstaller` if air-gapped installs become a
requirement.

### Installer languages

`bundle.windows.nsis.languages` is set to `["SimpChinese", "English"]`. Tauri's default
is `["English"]` alone, which hands a Chinese-first project an English-only installer.
NSIS picks the language from the OS locale and falls back to the **first** entry in the
list, so zh-CN Windows gets Chinese and every other locale gets English.
`displayLanguageSelector` stays at its default (`false`) — the language follows the
system, and no extra page is added to the installer.

The entries are NSIS's contributed language file names (`SimpChinese.nlf` / `.nsh`,
the file defining `${LANG_SIMPCHINESE}`), not BCP 47 tags. Adding a language here only
takes effect on a Windows build, so it is verified by the NSIS row of the CI bundle
matrix rather than locally.

## macOS

- `bundle.macOS.minimumSystemVersion` is pinned to `10.13` explicitly. That matches
  Tauri's own default and sits above `objc2`'s floor of 10.12, so the value is
  correct today — it is written down so a future Tauri default bump cannot silently
  move our support floor. A universal bundle declares the _lower_ floor: the x86_64
  slice runs on 10.13, the arm64 slice only exists on 11.0+ machines anyway.
- Releases are built as `universal-apple-darwin` (`release.yml`). `macos-latest` is
  an arm64 host, so without `--target universal-apple-darwin` the `.dmg` would be
  arm64-only and Intel Macs could not install it. This needs both
  `aarch64-apple-darwin` and `x86_64-apple-darwin` installed, which the `targets`
  input of the `setup-rust` composite handles. Cost: two full Rust compiles, so the
  macOS release job is the slowest of the three.

## Auto-update (updater signing) — wired up

In-app auto-update runs on `tauri-plugin-updater`, which is **separate from OS code
signing**. It verifies a minisign signature over each update artifact; it does not make
Gatekeeper or SmartScreen trust the installer (that is the section below).

How it fits together:

- `bundle.createUpdaterArtifacts: true` makes `tauri build` emit an updater artifact per
  platform (Windows `.nsis.zip`, macOS `.app.tar.gz`) plus a `.sig` next to each, and a
  `latest.json` manifest.
- `plugins.updater.pubkey` in `tauri.conf.json` is the minisign **public** key. The
  matching private key was generated with `tauri signer generate` and lives **only** in
  the repo secrets — never committed (`.secrets/` is gitignored).
- `release.yml` passes `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  as env to the build; `tauri build` signs the artifacts and writes the `.sig` values into
  `latest.json`. Without those secrets a build with `createUpdaterArtifacts` **fails** — a
  deliberate trip-wire so an unsigned release can't ship silently.
- `plugins.updater.endpoints` points at
  `releases/latest/download/latest.json`. The app fetches it, compares versions, verifies
  the signature with the bundled pubkey, then downloads + installs.

**Platform reach:** Windows and macOS only. Linux ships `deb`, which the updater cannot
patch in place (only AppImage is an updater target on Linux), so the app falls back to
"open the release page and download manually" there — see `lib/update-backend.ts`'s
`manual` mode.

**Setup once (repo owner):** create two GitHub Actions secrets —
`TAURI_SIGNING_PRIVATE_KEY` (the contents of the generated key file) and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty if the key has no password). Lose the private
key and every future auto-update breaks; there is no recovery except shipping a new pubkey
in an app update users install manually.

**Known caveat:** the three release jobs run in parallel and each uploads to the same
release. `tauri-action` fetches and merges `latest.json`, but two jobs finishing at the
exact same moment can race. Only Windows and macOS write updater artifacts (Linux does
not), so the window is two jobs wide; if a merge is ever lost, re-running the affected job
re-uploads a merged manifest.

## Code signing & notarization — not wired up yet

Deliberately left out: both require certificates we do not have, and wiring the
steps up without the secrets only turns a working workflow into a failing one.
What each side needs:

**macOS** — an Apple Developer Program membership and a _Developer ID Application_
certificate.

1. Export the cert as `.p12`, base64 it into a secret, and import it on the runner
   (or set `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`, which `tauri-action`
   understands natively).
2. Set `bundle.macOS.signingIdentity` in `tauri.macos.conf.json`.
3. For notarization set `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and
   `APPLE_TEAM_ID`, or the App Store Connect API key triple
   (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`).
4. `hardenedRuntime` is already on by default; add an entitlements file only if a
   capability is denied.

Until then, Gatekeeper quarantines the downloaded `.dmg`. Users can right-click →
Open, or run `xattr -dr com.apple.quarantine /Applications/GreyWork.app`.

**Windows** — an OV or EV code-signing certificate (EV avoids the SmartScreen
reputation warm-up).

1. `bundle.windows.certificateThumbprint` + `digestAlgorithm` (`sha256`) +
   `timestampUrl`, with the cert imported into the runner's certificate store; or
   `bundle.windows.signCommand` for a custom signer.
2. EV certificates on hardware tokens need a cloud signing service instead of a
   `.pfx` in a secret.

Until then, SmartScreen warns on the unsigned NSIS installer.

## Building locally

```sh
pnpm tauri build                    # uses the platform config above
pnpm --filter @greywork/desktop tauri build --bundles deb   # explicit override
```

Artifacts land in `src-tauri/target/release/bundle/<type>/`.

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
