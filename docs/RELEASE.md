# Release

How Frappe Studio versions, what a release consists of, and how the record of "what upstream
this was built from" is captured and displayed.

## Versioning scheme

- **Product semver is decoupled from the upstream version.** Frappe Studio's version lives in
  `package.json` as `"name": "frappe-studio", "version": "1.0.0"`. The upstream Code-OSS
  version (`1.146.0` for this release) is recorded separately, below.
- Product version bumps follow ordinary semver practice: MAJOR for behavioral/UX breaks,
  MINOR for shipped features, PATCH for fixes. Upstream merges do **not** necessarily bump the
  product version — they bump the recorded upstream base instead.
- Code-OSS licensing is respected throughout: Frappe Studio is based on Code-OSS, is
  MIT-licensed, and acknowledges Microsoft contributors and the broader Code-OSS community.
  Microsoft branding must never be used to imply Microsoft released or endorses this product.

## Recording the upstream base

The exact upstream commit Frappe Studio is built from is recorded in two places:

1. `scripts/upstream/config.json` — the machine-readable record used by the upstream tooling
   (`npm run upstream:check | upstream:fetch | upstream:sync | upstream:status | upstream:report |
   upstream:test`, provided by `scripts/upstream/`, Node-only with zero npm dependencies).
2. A git ref `refs/frappe-studio/upstream-base` — a stable local pointer to the base commit,
   kept accurate on every upstream sync.

An upstream sync does not commit into the fork until the recorded base is updated too; the two
are supposed to drift lockstep.

## Displaying the upstream base

The **Frappe Studio About dialog** is a custom command, `frappeStudio.about` ("Frappe Studio:
About"), registered by the Frappe Studio contribution. It shows:

- Frappe Studio product version (from `package.json`)
- Upstream Code-OSS base version and the base commit SHA from `scripts/upstream/config.json`
- The standard Code-OSS license and attribution text (MIT; acknowledgment of Microsoft
  contributors and the Code-OSS community)

Users release-reporting a bug should be pointed at this dialog; the pairing of product version
+ base commit is what makes a report reproducible.

## Packaging

Packaging uses the fork's own build pipeline (see `.github/workflows/release.yml`), producing
installers for the supported targets: **Windows x64** and **Linux x64**. **macOS is untested
and unsupported for the 1.0.0 release.** Product identity in installers comes from
`product.json` branding: `nameShort` "Frappe Studio", `nameLong`, `applicationName`
`frappe-studio`, `dataFolderName` `.frappe-studio`, `urlProtocol` `frappe-studio`, plus the
`win32*` identifiers that keep Windows installs distinct from any Code-OSS installation.
The About dialog command (`frappeStudio.about`) rather than any bundled-vscode-specific
help/about implementation is what users should see and be pointed at.

## GitHub workflows

| Workflow | What it does |
| --- | --- |
| `.github/workflows/build.yml` | compile + typecheck (`pnpm run compile`, `pnpm run typecheck-client`) |
| `.github/workflows/test.yml` | unit tests (`scripts/test.bat` on Windows; `scripts/test.sh` on Linux), including the frappeStudio mocha suites |
| `.github/workflows/release.yml` | packaging for Windows x64 and Linux x64 |
| `.github/workflows/upstream-check.yml` | scheduled (cron) + manual dispatch upstream check: compares the recorded base against `microsoft/vscode` and reports drift |
| `.github/workflows/upstream-sync.yml` | opens an integration branch named `fedFest/frappe-studio/upstream-{date}` for the update; **automatic merge into main is never allowed when conflicts or test failures exist** |

The workbench builds also run `pnpm run eslint` on the frappeStudio contribution, keeping the
frappeStudio contribution compliant with repo hygiene.

## Release checklist

1. `git status` clean; `pnpm run compile`, `pnpm run typecheck-client`, `pnpm run eslint` all
   pass locally.
2. Unit tests pass (`scripts/test.bat --run src/vs/workbench/contrib/frappeStudio/test/...`
   suites and the standard Code-OSS test entry point).
3. `npm run upstream:status` (see `docs/upstream/UPDATE_GUIDE.md`) — confirm the recorded base
   (`scripts/upstream/config.json` and the ref `refs/frappe-studio/upstream-base`) matches the
   tree you're about to release.
4. Integration verification against a disposable development Frappe site (see
   `docs/TROUBLESHOOTING.md`) for the flows shipped in this release.
5. Bump `"version"` in `package.json` per semver; confirm `product.json` branding is intact
   (a branding drift is one of the highest-risk accidental regression spots on merges, see
   `docs/upstream/MODIFIED_UPSTREAM_FILES.md`).
6. Tag the release (e.g. `v1.1.0`) and push; `release.yml` picks up the tag and packages
   Windows x64 + Linux x64 artifacts.
7. Post-release, an `upstream-check` run records any new upstream drift for the next cycle.
