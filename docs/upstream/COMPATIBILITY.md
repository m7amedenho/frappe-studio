# Compatibility

What upstream Code-OSS versions Frappe Studio supports, how that support is decided, and how
compatibility considerations interact with the fork-maintenance work in this directory.

## Relationships at a glance

- Frappe Studio is built on Code-OSS, MIT-licensed; credit and license acknowledgment to
  Microsoft contributors and the Code-OSS community is carried in the product's About dialog
  (`frappeStudio.about`) and throughout docs. No misleading use of Microsoft branding.
- Product side: `package.json` says `"name": "frappe-studio", "version": "1.0.0"`; the current
  release pairs that with Code-OSS base `1.146.0` at commit
  `1745a4a6102e93173430b4b2debc1247a91cd036`.
- The base commit lives in `scripts/upstream/config.json` and the git ref
  `refs/frappe-studio/upstream-base`, and is displayed by the About command alongside the
  product version. See `docs/RELEASE.md`.

## How compatibility is scoped

"Which upstream version does Frappe Studio support" is answered in two layers:

1. **Recorded base** — the exact upstream commit we build on. Supported = this commit and
   anything between it and the last `npm run upstream:status`-verified base.
2. **Compatibility surface beyond the base** — whether the fork's own three-file surface
   (per `MODIFIED_UPSTREAM_FILES.md`) and the frappeStudio contribution still hold against
   newer upstream attempts. Verified empirically by `npm run upstream:test`, not declared
   blindly.

This page answers "how hard would it be to move to a new base" rather than promising a single
"supported upstream version" forever.

## Features depending on upstream behavior

Most of Frappe Studio does not touch upstream behavior at all. The parts that rely on it:

| Frappe Studio surface | Upstream dependency |
| --- | --- |
| Sidebar views (Overview/Site Explorer, Apps, DocTypes, Bench) | workbench view/pane registry, activity-bar view containers — stable APIs used by first-party contributions like the git/SCM/debug features |
| Webview editors (DocType Studio, Workflow Designer, API Explorer, Print Format Designer, Report Runner, Database Explorer) | webview editor message protocol and CSP model; if upstream hardens the CSP or changes the message channel, the shared base (`editors/frappeWebviewEditor.ts`) is the only file that needs work |
| Reports Studio's `frappe-report:` file system provider | upstream file-system provider API |
| Connections / secrets | `ISecretStorageService` (OS keychain-backed), application storage (fork uses keys `frappe-studio.connections.v1` and service `frappe-studio`) |
| Bench Manager terminal workflows | integrated terminal API, plus `wsl.exe` behavior on Windows for WSL-marked contexts |
| About dialog (`frappeStudio.about`) | reads `package.json` version and `scripts/upstream/config.json` base — nothing upstream-specific |

Because every one of those dependencies is used the way first-party features (git, debug, SCM)
already use them, upstream's own testing catches breakages in that surface long before Frappe
Studio can encounter them — that's the biggest reason the contribute-don't-fork strategy works.

## Known constraint: this isn't a VS Code product

Code-OSS is not Visual Studio Code. Two consequences worth stating plainly:

- **Marketplace access**: Frappe Studio inherits what Code-OSS has — the open source extension
  marketplace and whatever VSIX installation path Code-OSS supplies. No Visual Studio
  Marketplace integration is added by the fork.
- **Branded identity**: everything user-visible is "Frappe Studio". No Microsoft name, logo,
  or product claim is added anywhere — `product.json` `nameShort` "Frappe Studio",
  `applicationName` `frappe-studio`, `urlProtocol` `frappe-studio`, `dataFolderName`
  `.frappe-studio`, per `docs/upstream/MODIFIED_UPSTREAM_FILES.md`.

## Components checked after every upstream sync

When an upstream update lands, this is the checklist:

1. **Tooling survives**: `npm run upstream:status` — base recorded correctly, three-file
   surface intact.
2. **Compile + typecheck** match CI gates (`pnpm run compile`, `pnpm run typecheck-client`).
3. **Tests** — including the frappeStudio mocha suites in
   `src/vs/workbench/contrib/frappeStudio/test/` (frappeUrl, frappeMetadata, cookieJar,
   frappeCapabilities).
4. **Secrets still work**: connect a site, confirm the credentials flow still reaches the OS
   keychain-backed secret service (`ISecretStorageService`) and the cookie jar is unaffected
   (nothing regressed in the platform secret storage path).
5. **Webview editors still load** with CSP restrictions intact (nonce scripts, no remote
   resources) after landing platform CSP changes upstream.
6. **Terminal for bench still works** for both native and `wsl.exe` contexts on Windows x64
   and Linux x64. macOS remains untested/unsupported for 1.0.0.
7. **About command** (`frappeStudio.about`) renders product version + recorded upstream base.

## Platform constraints with no upstream workaround

These limits come from what Code-OSS itself is, so they apply regardless of the fork's work:

- `ISecretStorageService` on Linux needs a keyring daemon running (`gnome-keyring`, KWallet,
  etc.); without one, secrets storage degrades on the platform level.
- File watchers / native modules remain what Code-OSS ships (Node 24.22.1 per `.nvmrc`,
  pnpm 12.16.0 per `packageManager`; Windows build requires VS 2022 Build Tools with C++).
- Development and PR flow follows `docs/DEVELOPMENT.md`.

The practical compatibility rule derives directly from all of this: upstream changes may
nothing about Frappe Studio's Frappe-network semantics, secret storage, or capabilities except
where they genuinely affect the platforms described above, and regressions surface as those
platform surfaces failing — not as silent, irreversible changes to the mainline.
