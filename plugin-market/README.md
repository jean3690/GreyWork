# Plugin Market

Source of the official GreyWork plugin registry.

```
plugin-market/
├── registry.json        # the catalog the desktop app fetches
├── packages/            # plugin package JSON (+ worker JS) referenced by registry.json
├── templates/           # copy-me skeletons for new plugins
├── sign_registry.py     # ed25519 signing / verification for registry.json
└── .signing-key.pem     # private key (gitignored; only the signing script uses it)
```

The desktop host trusts this registry through a hard-coded ed25519 public key
(`OFFICIAL_REGISTRY_PUBLIC_KEY` in `apps/desktop/src-tauri/src/plugin_market.rs`). A valid signature
means a compromised GitHub account still cannot poison the catalog: tampering with `registry.json`
invalidates the signature. Third-party registries may be unsigned ("use at your own risk"), but a
registry served from the official URL **must** be signed — the URL is compared in normalized form
(scheme/host/path, case-insensitive host, trailing slash ignored) so a variant URL cannot downgrade
the check.

## Add a package

1. Copy a skeleton from `templates/` to `packages/<id>.json` and fill it in. See
   [../docs/plugin-authoring.md](../docs/plugin-authoring.md) for the full manifest reference.
   Worker plugins also need the pinned `<id>.js` module.
2. Compute the package hash:

   ```bash
   sha256sum packages/<id>.json
   ```

3. Add a `plugins[]` entry to `registry.json` with `id`, `name`, `version`, `downloadUrl` (GitHub
   HTTPS, pinned commit) and `sha256`.
4. Sign the registry (the signature covers everything except the `signature` field itself):

   ```bash
   python3 sign_registry.py          # sign in place
   python3 sign_registry.py --verify # confirm it matches the host public key
   ```

5. Run the Rust tests — they verify the shipped registry against the host key and validate every
   package (`shipped_registry_verifies_against_host_public_key`,
   `shipped_market_packages_pass_validation`):

   ```bash
   cd apps/desktop/src-tauri && cargo test plugin_market
   ```

   A stale `sha256`, a broken schema, or a registry/package version mismatch fails here instead of
   in users' installs.

## Signing key

The private key is `plugin-market/.signing-key.pem` (gitignored) and must correspond to the host's
public key constant. If it is missing:

```bash
openssl genpkey -algorithm ed25519 -out plugin-market/.signing-key.pem
```

Rotating the key means updating `OFFICIAL_REGISTRY_PUBLIC_KEY` (Rust) and `HOST_PUBLIC_KEY_HEX`
(`sign_registry.py`) together.

## Package integrity

The host re-verifies each package on download:

- the registry entry's `sha256` must match the downloaded package bytes;
- for worker plugins, `runtime.entry` is fetched separately and must match `runtime.sha256`;
- `validate_package` re-checks the full schema, GitHub-only URLs, and all size bounds.

Keep `runtime.entry` pinned to a commit SHA so the hash stays stable across pushes.
