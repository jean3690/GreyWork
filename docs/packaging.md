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
