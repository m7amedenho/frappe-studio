# Developing Frappe Studio

This guide covers building, running, testing and static-checking Frappe Studio on Windows x64
and Linux x64 (the supported targets for 1.0.0; macOS is untested and unsupported for this
release).

Frappe Studio is a fork of Code-OSS, so development follows the standard Code-OSS flow. The
product-specific code lives in `src/vs/workbench/contrib/frappeStudio/` and its docs in
`docs/`; everything else is stock upstream (see `docs/upstream/MODIFIED_UPSTREAM_FILES.md` for
the three exceptions).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 24.22.1 (pinned by `.nvmrc`) | Node 24.x; other majors will break native module builds and resolution |
| pnpm | 12.16.0 | pinned via `packageManager` in `package.json`; Corepack resolves it |
| Python | 3.12 verified (3.10+) | used by native module builds (gyp) |
| Git | — | remotes `origin` (fork) and `upstream` (`microsoft/vscode`) configured |
| Windows only | Visual Studio 2022 Build Tools with the **C++ workload** | required to compile native modules (node-gyp); install via the VS Installer |
| Linux only | `build-essential`, `libkrb5-dev`, `libxkbfile-dev` and friends | same package set Code-OSS documents |

### Setup commands

```bash
git clone https://github.com/m7amedenho/frappe-studio.git frappe-studio
cd frappe-studio
nvm use              # selects Node 24.22.1 from .nvmrc
pnpm install         # Corepack honors packageManager: pnpm@12.16.0
```

If `pnpm install` fails on Windows with a native module error, confirm the VS 2022 Build Tools
C++ workload is installed and that `node` is 24.x (`node -v`).

## Build and run (development)

```bash
pnpm run compile            # compiles the workbench (incremental watch: pnpm run watch)
```

Then launch the development build:

- **Windows**: `scripts\code.cmd`
- **Linux**: `./scripts/code.sh`

This opens the Frappe Studio development build with the Frappe Studio contribution loaded —
the Frappe Studio icon in the activity bar, the Welcome view with **Connect to Site**, and the
Bench Manager terminal workflows are all live.

## Static checks

```bash
pnpm run typecheck-client   # TypeScript checks for the client sources
pnpm run eslint             # lint rules, including the frappeStudio contribution
```

Run both before committing. Compilation succeeding is not enough — the repo's hygiene rules
(password/special paths like `https?://[^@]*@`, lint boundaries for upstream directories) are
enforced by CI.

## Testing

Unit tests live in `src/vs/workbench/contrib/frappeStudio/test/` and follow the repository's
existing conventions: mocha TDD style (`suite`/`test`), pure modules only, **no network**
access. The modules that currently have dedicated suites are:

- `common/frappeUrl.ts` — URL normalization and validation rules
- `common/frappeMetadata.ts` — reconcile/validate logic
- `connection/cookieJar.ts` — cookie container behavior
- `common/frappeCapabilities.ts` — probe parsing and version detection

Run a suite the same way other Code-OSS unit tests are run:

```bash
scripts\test.bat --run src/vs/workbench/contrib/frappeStudio/test/common/frappeUrl.test.ts
```

(On Linux, `scripts/test.sh --run <relative path>`.)

## Integration verification against a real site

Unit tests never hit the network because they must not depend on one. Verifying the product
end-to-end, however, requires a **real Frappe site**; there is no mock server in the repo. The
recommended procedure is documented in `docs/TROUBLESHOOTING.md` ("Verification against a
disposable development Frappe site"). Short version: spin up a throwaway bench and site, point
a development build at it, and step through connect → explore → edit → save → verify flows.
Never test saves against a site you care about.

## Repository layout (what lives where)

- `src/vs/workbench/contrib/frappeStudio/` — all Frappe Studio product code; see
  `docs/ARCHITECTURE.md` for the internal layout.
- `docs/` — this documentation tree.
- `scripts/upstream/` — Node-only (zero npm dependencies) tooling for upstream sync
  (`npm run upstream:check | upstream:fetch | upstream:sync | upstream:status | upstream:report |
  upstream:test`); base commit is recorded in `scripts/upstream/config.json`.
- Everything else is upstream Code-OSS and should remain untouched — before editing any file
  under `src/`, `build/` or `.github/` that is not inside the frappeStudio contribution, read
  `docs/upstream/CONFLICT_POLICY.md`.

## Debugging tips

- Workbench contributions are loaded synchronously from
  `src/vs/workbench/workbench.common.main.ts`; if the Frappe Studio views disappear after an
  upstream merge, check that the single import line there survived (this is the highest-risk
  3-line change in the repo).
- Webview editors log through the shared webview base (`editors/frappeWebviewEditor.ts`);
  open the Workbench developer tools (from the command palette: toggle developer tools) to see
  webview console output.
- Bench commands run in the integrated terminal — watch the actual pane rather than guessing
  at exit codes; cwd and `wsl.exe` invocation are visible there.
