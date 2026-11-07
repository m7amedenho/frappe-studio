# Upstream Update Guide

The exact sequence a maintainer runs to bring Frappe Studio forward on top of a new upstream
Code-OSS. Prerequisites: fresh clone of the fork; `origin` = `m7amedenho/frappe-studio`,
`upstream` = `microsoft/vscode`; Node 24.22.1 (`.nvmrc`), pnpm 12.16.0 installed;
`scripts/upstream/config.json` shows the current recorded base.

The tooling used here comes from `scripts/upstream/` (Node-only, zero dependencies), exposed
as npm scripts. For the merge rules themselves, read `docs/upstream/CONFLICT_POLICY.md` before
your first sync.

## The command sequence

```bash
# 0. Preconditions: clean tree, remotes in place
git status                      # must be clean
git remote -v                   # origin = fork, upstream = microsoft/vscode

# 1. Check for drift (safe, read-only)
npm run upstream:check          # stops early if no new upstream commit exists

# 2. Fetch upstream (safe, does not merge)
npm run upstream:fetch

# 3. Trust-but-verify: what the update brings
npm run upstream:report         # human-readable summary since our recorded base

# 4. Create the integration branch, then run the merge
git checkout -b fedFest/frappe-studio/upstream-$(date +%Y-%m-%d)
npm run upstream:sync           # performs the merge against the recorded base

# 5. Health after the merge
npm run upstream:status         # recorded base vs HEAD, modified-file health
npm run upstream:test           # compile/typecheck plus Frappe-Studio-sensitive checks

# 6. Full verification (same gates CI uses)
pnpm install
pnpm run compile
pnpm run typecheck-client
pnpm run eslint
scripts/test.bat --run src/vs/workbench/contrib/frappeStudio/test/common/frappeUrl.test.ts
#   (Linux: scripts/test.sh --run …)

# 7. Manual smoke: launch and confirm the Frappe Studio contribution is alive
scripts\code.cmd                # Linux: ./scripts/code.sh
#   - Frappe Studio activity-bar icon renders
#   - About dialog command (frappeStudio.about) shows product + upstream base
#   - product.json branding intact, data folder is ~/.frappe-studio

# 8. Only when everything is green: update the recorded base (two places, lockstep)
#    - scripts/upstream/config.json → new base SHA
#    - git ref refs/frappe-studio/upstream-base → same SHA
git push origin HEAD            # integration branch; do NOT merge to main if conflicts or failures exist
```

The dated-branch naming (`fedFest/frappe-studio/upstream-{date}`) is what
`.github/workflows/upstream-sync.yml` opens automatically; the manual sequence above is the
same flow done locally.

## After the merge: the three files

`docs/upstream/MODIFIED_UPSTREAM_FILES.md` is the definitive list; before pushing, confirm
each:

1. `src/vs/workbench/workbench.common.main.ts` — the frappeStudio contribution import line is
   still present and grouped correctly.
2. `product.json` — Frappe Studio branding keys still applied (`nameShort` "Frappe Studio",
   `applicationName` `frappe-studio`, `dataFolderName` `.frappe-studio`, `urlProtocol`
   `frappe-studio`, `win32*` identifiers), and that upstream's new keys were kept verbatim.
3. `package.json` — `name` is `frappe-studio`, `version` is the product version (independent
   of the upstream version), and the `frappe-studio:*` npm scripts are intact. Re-run
   `pnpm install` if upstream changed dependency lock-time state.

## Decision points

- **Merge candidate is clean, tests pass** → push the integration branch, open the PR; merging
  to main once CI is green is allowed. Update the recorded base and ref as step 8.
- **Conflicts or failures exist** → **automatic merge into `main` is not allowed**; resolve on
  the integration branch per `docs/upstream/CONFLICT_POLICY.md`; never force-merge and never
  re-run automerge tools over a branch that is already known-broken.
- **Update looks huge** (editor core rewrites) → run it anyway, but split into multiple
  integration branches across time; smaller merges are easier to bisect later.

## Recovering from a broken state

- `git reflog` inside the integration branch first; the pre-merge HEAD is always reachable
  there, plus `refs/frappe-studio/upstream-base` points at the last known-good base.
- `npm run upstream:report` also works after a partial merge to show the drift boundary you
  merged to.
- A merge that cannot be completed cleanly without meaningless churn is a sign the forked
  three-file surface is at risk — re-read `MODIFIED_UPSTREAM_FILES.md` before forcing a
  resolution.
