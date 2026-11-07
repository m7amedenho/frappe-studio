# Upstream Strategy

Frappe Studio is a fork of **Code-OSS** (`microsoft/vscode`, MIT-licensed) with credits owed
to Microsoft contributors and the broader Code-OSS community; Frappe Studio itself stays
MIT-licensed and adds a Frappe Framework IDE on top. This document explains why the fork stays
as close to upstream as it does, and how the relationship is maintained.

## Remotes

- `upstream` → `https://github.com/microsoft/vscode` (the source of truth)
- `origin` → `https://github.com/m7amedenho/frappe-studio` (the fork)

## Why contribute, don't fork harder

The workbench contribution model that Code-OSS itself uses for built-ins (git/SCM/debug) is
powerful enough to host an IDE-class feature set natively. Everything Frappe Studio adds lives
in `src/vs/workbench/contrib/frappeStudio/`, following that same pattern. That choice has two
payoffs:

1. **Merge surface is tiny.** Upstream files Frappe Studio had to modify are exactly three
   (one import line, two configuration files) — tracked precisely in
   `docs/upstream/MODIFIED_UPSTREAM_FILES.md`. Everything else under `src/`, `build/` and
   `.github/` matches upstream byte-for-byte except for additive files Frappe Studio owned.
2. **Upstream fixes flow to us directly.** editor regressions, build hardening, security
   patches, new APIs — merged in without reimplementation.

## Tracking the base

- The base commit is `1745a4a6102e93173430b4b2debc1247a91cd036` (Code-OSS 1.146.0 era).
- The base is recorded in two places that must move lockstep:
  - `scripts/upstream/config.json` — read by the Node-only upstream tooling.
  - the git ref `refs/frappe-studio/upstream-base`.

## The tooling: scripts/upstream

`scripts/upstream/` is Node-only, with **zero npm dependencies**, so it runs on any dev
machine without reinstalling anything. It provides these npm scripts:

| Script | Purpose |
| --- | --- |
| `npm run upstream:check` | compare the recorded base against `upstream/master` and report whether an update exists |
| `npm run upstream:fetch` | fetch upstream commits and stage them locally, but don't merge |
| `npm run upstream:sync` | perform the actual merge/rebase onto the recorded base, wired with the fork's conflict handling |
| `npm run upstream:status` | show drift: recorded base, latest fetch state, modified-upstream-file health |
| `npm run upstream:report` | generate a human-readable report of what an update would bring |
| `npm run upstream:test` | run the fork's upstream-merge safety checks (compile/typecheck plus Frappe Studio-sensitive areas) |

## Where automation lives

- `.github/workflows/upstream-check.yml` — scheduled (cron) + manual dispatch; surfaces drift
  in the repository early so it doesn't accumulate.
- `.github/workflows/upstream-sync.yml` — opens an integration branch named
  `fedFest/frappe-studio/upstream-{date}` for the update. **Automatic merge into `main` is
  never allowed when conflicts or failures exist.** The integration branch exists precisely so
  the human-in-the-loop merge is done there, not in main. Automatic merges of clean updates
  are allowed — but only after the merge produces no conflicts and passes
  `upstream:test` (see `docs/upstream/UPDATE_GUIDE.md`).
- `.github/workflows/build.yml` (compile + typecheck) and
  `.github/workflows/test.yml` (unit tests) gate both integration branches and main.
- `.github/workflows/release.yml` builds and packages Windows x64 and Linux x64 (macOS is not
  a supported target on 1.0.0).

## Product identity vs upstream identity

`product.json` branding (`nameShort` "Frappe Studio", `applicationName` `frappe-studio`,
`dataFolderName` `.frappe-studio`, `urlProtocol` `frappe-studio`, plus `win32*` identifiers)
and `package.json` name/version keep the product distinct from Code-OSS. The token rule:
Frappe Studio's About dialog command (`frappeStudio.about`) is the user-facing surface that
shows both product version and the recorded upstream base — so "what version is this" and
"what upstream is this from" are always answerable together.

## How to read the other docs in this directory

| Doc | Covers |
| --- | --- |
| `MODIFIED_UPSTREAM_FILES.md` | the precise, complete list of upstream files Frappe Studio owns (currently 3) |
| `UPDATE_GUIDE.md` | the exact command sequence for running an upstream update |
| `CONFLICT_POLICY.md` | decision tree for resolving merge conflicts |
| `COMPATIBILITY.md` | how to judge what upstream changes are safe for Frappe Studio |
