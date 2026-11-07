# Upstream Synchronization (frappe-studio)

This directory holds the tooling that keeps the fork (`origin` = `m7amedenho/frappe-studio`)
synchronized with its upstream (`upstream` = `microsoft/vscode`), **without ever auto-merging
into `main`, never force-pushing, and never auto-resolving conflicts**.

```
node scripts/upstream/upstream.mjs <command>
```

All commands are zero-dependency (Node ≥ 24, ESM, std-node only) and are safe to run from a
maintainer machine or from GitHub Actions.

## Configuration — `config.json`

| Key | Meaning |
|-----|---------|
| `upstreamRemote` / `upstreamRef` | git remote and ref tracked upstream (`upstream` / `main`) |
| `forkRemote` / `mainBranch` | where the fork's working branch lives (`origin` / `main`) |
| `upstreamBaseCommit` | last upstream commit fully absorbed by the fork. `sync` advances it on success |
| `upstreamBaseTagRef` | local ref mirror of the base (`refs/frappe-studio/upstream-base`), updated by `git update-ref` by `sync` |
| `syncBranchPrefix` | sync branches are named `<syncBranchPrefix>-<yyyyMMdd>` (UTC), e.g. `upstream-sync-20260202` |
| `protectedPaths` | paths owned by the fork; changes there always require human review during a sync |
| `mechanicallyResolvableConflictKinds` | conflict kinds that a human may resolve *with tooling* (`whitespace`, `import-order`) — never automatically |
| `maxCommitsBehindBeforeWarning` | informational threshold when drift gets big |

`upstreamBaseCommit` advancing is the single source of truth for "how far did we get".
The marker ref `refs/frappe-studio/upstream-base` documents the same point in git itself.

## Commands

### `check` — drift gate (used by CI)

1. `git fetch --prune upstream`
2. resolves `upstream/main` and verifies the recorded `upstreamBaseCommit` exists locally
   (fetching it from the remote by SHA if needed)
3. prints the base, the tip, the commit count behind (`git rev-list --count base..tip`),
   the changed-file list (three-dot `git diff --name-only base...tip`), and every changed
   file that lives under a `protectedPath`
4. exit codes: **0** = clean (no drift) · **1** = drift · **2** = drift touching protected paths ·
   **3** = fetch failure · **4** = config/base problems

CI gates on this. Drift is *reported*, never acted upon automatically.

### `status` — human dashboard

Prints base, tip, behind-count, working-tree state, pending merge conflicts (parsed from
`git status --porcelain`), and the last-checked time. Also stores that time and the facts in
`scripts/upstream/.status.json` (git-ignored).

### `fetch` — fetch and prune only. No comparisons, no files written.

### `report` — write a drift report

Writes `scripts/upstream/report/<yyyyMMdd-HHmmss>-upstream-report.md` and prints its path.
Contains: base, tip, merge shortstats, the full oneline commit list (capped at 300 lines),
changed files grouped by top-level directory with protected paths flagged
(`:rotating_light: PROTECTED`), a doc-guidance link table, and compare links.
Runs a fetch first so the report is fresh.

### `sync` — the update workflow

In order:

1. **Clean tree required.** Any tracked/modification/staged entry aborts the run. Untracked
   files are allowed (a plain `git merge` would still refuse to overwrite them).
2. **Must run on `main`.** Falls back to error (never to force-anything).
3. **Record the base** and stop cleanly if the upstream is not ahead.
4. **Create branch** `upstream-sync-<yyyyMMdd>` (branch names are deterministic per UTC date;
   an existing branch aborts the run instead of being overwritten).
5. **Real merge** (`git merge --no-ff --no-edit -m "chore: sync upstream <short-sha>"`).
   - On **conflicts**: record them, run `git merge --abort`, generate
     `scripts/upstream/report/<timestamp>-conflicts.md` (every conflicted file, its owning
     protected path if any, its inferred kind and per-file guidance, plus the CONFLICT POLICY),
     restore `main`, leave the branch in place, and exit non-zero. **Nothing is auto-resolved.**
   - On other merge failures: abort cleanly, restore `main`, exit non-zero.
6. **Tests**: run `node scripts/upstream/upstream.mjs test` (see below). Failures keep the
   merge commit on the sync branch for inspection, restore `main`, and exit non-zero.
7. **Required checks**: run `pnpm run typecheck-client` when `pnpm` is available in PATH and
   the script exists; otherwise the check is *skipped with a loud warning* in the report and
   the maintainer must run it locally before the PR is published.
8. **On success**: update `config.json`'s `upstreamBaseCommit` to the new tip, move the
   `refs/frappe-studio/upstream-base` marker ref, and fold both into the merge commit so the
   result is a **single commit** `chore: sync upstream <short-sha>` (a local `--amend` of the
   brand-new merge commit — no history rewriting of anything shared).
9. Print next steps. **`sync` never pushes, never merges to `main`, never force-pushes.**

If any step fails, `sync` aborts cleanly: back on `main`, sync branch left as-is for
inspection, clear error. Product changes are never discarded.

### `test` — integration self-checks before declaring a sync successful

1. Diff `main` vs the worktree (`git diff --name-only main`) and verify fork-authored changes
   are inside the allowed set
   (`src/vs/workbench/contrib/frappeStudio/**`, `package.json`, `product.json`,
   `scripts/upstream/**`, `.github/**`, `docs/**`, plus the integration seam service file used
   transitively). Files that differ from `main` *only because the merge inherited them from
   upstream* are recognized as inherited and only produce an informational note; a file the
   fork itself edited outside the allowlist is a failure.
   Practical approximations of integration integrity: `src/vs/workbench/contrib/frappeStudio`
   must exist with TypeScript sources, and `src/vs/workbench/workbench.common.main.ts` must
   still reference `frappeStudio` (the contribution import line survives the merge).
2. Run `scripts/upstream/selftest.mjs` (pure unit tests, below).

Exit non-zero on any failure.

## Conflict policy (referenced verbatim in conflict reports)

- Conflicts are **never auto-resolved** — no scripted resolution, no `rerere`, no `--theirs`.
- **Protected paths** (fork-owned) always mean a human reads both sides.
- Mechanically resolvable kinds (`whitespace`, `import-order`) may be fixed *by a human with
  tooling* (formatters, import sorters); tooling never drives the merge and everything stays
  under review.
- Resolutions must preserve the frappeStudio integration seam in
  `src/vs/workbench/workbench.common.main.ts` — that is exactly what `upstream.mjs test` gates.
- The sync branch is pushed **for a PR**; nothing auto-merges into `main`, nothing is
  force-pushed, and nothing is ever pushed to `upstream`.

## Components

| File | Role |
|------|------|
| `config.json` | synchronisation settings (see above) |
| `lib.mjs` | pure shared helpers: safe-args `runGit`, `countCommitsBehind`, `changedFilesBetween`, `isProtectedPath`, `inferConflictKind`, `decideConflictAction`, porcelain parsing, TZ-deterministic date/branch-name formatting, report generation. Importing it runs no git and writes nothing, so `selftest` can use it anywhere |
| `upstream.mjs` | the CLI (all subcommands above) |
| `selftest.mjs` | pure unit tests for the helpers: `node scripts/upstream/selftest.mjs` (PASS lines + exit code 0/1) |
| `repo-sanity.mjs` | repo config sanity: `package.json`/`product.json`/`config.json` parse, frappeStudio directories exist, the integration seam is present. `--strict` makes the seam check fatal (used by CI after integration lands) |
| `.status.json` | last-checked dashboard state (git-ignored) |
| `report/` | drift and conflict reports (git-ignored) |

## CI workflows

| Workflow | Trigger | Behavior |
|----------|---------|----------|
| `build.yml` | push/PR | node 24 + corepack pnpm, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run typecheck-client` |
| `test.yml` | push/PR | `upstream.mjs test` self-tests + `repo-sanity.mjs --strict` (no heavy gulp/compile in CI) |
| `upstream-check.yml` | weekly cron Mon 06:00 UTC + manual | `check` + `status` + `report`, uploads the report as an artifact, posts a notice on drift (never auto-merges) |
| `upstream-sync.yml` | weekly cron Mon 07:00 UTC + manual | runs `sync`; on success pushes the sync branch with the workflow token and says "open a PR"; on conflicts leaves the branch unpushed, uploads the conflict report and fails with its path |
| `release.yml` | manual dispatch with `version` | typecheck + repo sanity, then tags `v<version>` and creates a GitHub release. Packaging (native toolchain) is intentionally **not** part of CI — maintainers run `build/` scripts from their machines |
