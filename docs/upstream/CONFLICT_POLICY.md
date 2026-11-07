# Conflict Policy

How merge conflicts during an upstream update are resolved — and, more importantly, which
conflicts are allowed to be auto-resolved and which are not. Reference material:
`docs/upstream/UPDATE_GUIDE.md` (the commands), `docs/upstream/MODIFIED_UPSTREAM_FILES.md`
(the three core files that create merge potential).

## The one strong rule

**Semantic conflicts are never auto-resolved.** A semantic conflict is any conflict where two
sides changed the same thing *in meaning* — not just in bytes. Auto-resolving one via
"whatever's in the fork" or "whatever's upstream" makes the wrong choice invisible at merge
time and visible as a bug later.

Only **mechanical conflicts** — where the two sides changed formatting or structure but not
meaning — may be auto-resolved:

- whitespace only (indentation, line endings, trailing whitespace),
- import-order / import-grouping only,
- equivalently, formatting-affecting-only lint fixes that upstream ran.

## Decision tree

```
Conflict encountered during `npm run upstream:sync` on the
integration branch fedFest/frappe-studio/upstream-{date}
│
├─ Is the file one of the fork-owned three (MODIFIED_UPSTREAM_FILES.md)?
│  ├─ workbench.common.main.ts — import line
│  │     merge upstream's import block first, THEN re-add the frappeStudio import line
│  │     (high risk; after resolving run `pnpm run compile` AND launch to confirm
│  │      the Frappe Studio activity-bar icon renders — never just compile)
│  ├─ product.json (branding)
│  │     take upstream's new file, then re-apply the fork's branding keys;
│  │     keep upstream's newly added keys verbatim (medium risk)
│  └─ package.json (name/version/frappe-studio:* scripts)
│        take upstream's file, re-apply the fork's identity keys + npm scripts;
│        dependency conflicts → take upstream's dependency set, then `pnpm install`
│        (the frappeStudio work never pulls its own deps onto package.json)
│
├─ Is the file purely whitespace/import-order differences?
│  └─ Mechanical: safe to auto-resolve (take either side, then re-run the tool
│     or formatting upstream used); mention in the integration-branch PR body
│
├─ Is the file something Frappe Studio never touched (non-fork-owned but not additive)?
│  ├─ Conflict present        → treat as semantic-by-default; manual review
│  │    (upstream changed a file we don't own AND another Frappe Studio commit
│  │     changed it too — re-read `git log` on that file to reconstruct why)
│  └─ No conflict             → take upstream verbatim as-is, no interaction needed
│
├─ Is the file under src/vs/workbench/contrib/frappeStudio/ (or additive elsewhere)?
│  └─ Entirely fork-owned → the merge cannot conflict here with upstream, and if it
│     does, something went wrong (bad rebase onto wrong base); investigate before touching
│
└─ Zero conflicts but tests/typecheck/build FAIL?
   └─ This is a **silent semantic conflict** — the most dangerous class.
      Do NOT auto-retry, do NOT hand-patch blindly. Treat like a conflict:
      run `npm run upstream:report` for context, open the failing file,
      bisect which upstream commit caused the change, fix semantically or
      defer the whole integration-branch into a separate PR with notes.
```

## Handled conflict classes in practice

| Class | Example | Resolution |
| --- | --- | --- |
| Mechanical — whitespace only | upstream re-indented a file | auto-resolve to either side; confirm via `npm run upstream:test` |
| Mechanical — import-order only | upstream inserted/reshuffled import blocks | auto-resolve; re-add the frappeStudio import line **after** the merge (goes under the high-risk-file rules above) |
| Semantic — fork-owned file, upstream moved something | `workbench.common.main.ts` renamed a section or split into two files | Manual re-apply; `MODIFIED_UPSTREAM_FILES.md` documents expected re-application steps |
| Semantic — dependency conflicts (package.json) | upstream bumped dependencies the fork also bumped | Take **upstream's** dependency versions (the frappeStudio work does not add its own
dependencies to `package.json` beyond what Code-OSS already ships) — divergence here creates
ghost-rebuild flakiness |
| Semantic — branding identity (product.json) | upstream reorganized product.json keys | Manual re-apply per `MODIFIED_UPSTREAM_FILES.md`; verify at launch, not just compile |
| Silent semantic — no textual conflict but tests fail | behavior drift underneath Frappe Studio | Never auto-resolve; manual bisect, then either fix (documented in the PR) or defer the update |

## What is never allowed

- Never auto-resolve a semantic conflict, even if CI would eventually catch it. The merge
  gate is a human reviewing the file, not the absence of a compile error.
- Never merge into `main` while conflicts or test/compile failures exist —
  `.github/workflows/upstream-sync.yml` opens the dated integration branch precisely so that
  this has a place to happen; that branch is where work continues, not main.
- Never delete fork-owned three-file entries to "make the merge easier" — that deletes the
  product.
- Never expand the fork-owned set without updating `MODIFIED_UPSTREAM_FILES.md` and wiring the
  new file into `npm run upstream:status`'s health-check list.
