/*---------------------------------------------------------------------------------------------
 * frappe-studio: upstream synchronization helpers
 * Copyright (c) Frappe Studio contributors. MIT License.
 *
 * Shared library for `scripts/upstream/upstream.mjs` and `scripts/upstream/selftest.mjs`.
 *
 * IMPORTANT: importing this module must NOT execute any git command or mutate any
 * file. Everything at import time is constant data; all side effects happen when
 * the exported functions are called. That keeps `selftest.mjs` runnable on any
 * machine without a git checkout of upstream.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (two levels up from scripts/upstream/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_PATH = path.join(ROOT, 'scripts', 'upstream', 'config.json');
export const STATUS_PATH = path.join(ROOT, 'scripts', 'upstream', '.status.json');
export const REPORT_DIR = path.join(ROOT, 'scripts', 'upstream', 'report');

/*---------------------------------------------------------------------------------------------*
 * CONFLICT POLICY (single source of truth; consumed by reports and README)
 *---------------------------------------------------------------------------------------------*/

export const CONFLICT_POLICY = [
    '## CONFLICT POLICY',
    '',
    '- Conflicts are **never auto-resolved**. There is no `--theirs`, no scripted',
    '  resolution, and no `git rerere` reuse for protected or integration files.',
    '- Conflicts in **protected paths** (see `config.json` `protectedPaths`) must be',
    '  resolved by a human who reads both sides: the fork owns these files first.',
    '- Conflicts classified as *mechanically resolvable* (`whitespace`, `import-order`)',
    '  may be fixed by a human **with mechanical tooling** (formatters, import-sorting',
    '  tools) — but a human still reviews the result before committing. Tooling never',
    '  drives the merge.',
    '- Conflicts that change the integration seam (e.g. `src/vs/workbench/workbench.common.main.ts`',
    '  where the frappeStudio contributions are imported) must preserve the frappeStudio',
    '  import/contribution lines. `node scripts/upstream/upstream.mjs test` verifies this.',
    '- If a resolution is unclear, prefer keeping upstream structure and re-placing the',
    '  fork code, then re-run `upstream.mjs test`, which gates on integration integrity.',
    '- Everything here is reviewed like any other change: a `upstream-sync-*` branch is',
    '  pushed for a PR, and **nothing ever auto-merges into `main`** and **nothing is',
    '  ever force-pushed**.',
].join('\n');

/** Doc guidance table used by `report` and conflict reports. */
export const DOC_LINKS = [
    { area: 'Sync workflow + subcommands', link: 'README: scripts/upstream/README.md (this repo)' },
    { area: 'Conflict policy', link: 'README: scripts/upstream/README.md#conflict-policy' },
    { area: 'Merge: doing and undoing', link: 'https://git-scm.com/docs/gitrevisions + git-merge(1), git-merge--abort(1)' },
    { area: 'Fixing upstream-introduced build/typecheck breaks', link: 'https://github.com/microsoft/vscode/wiki/How-to-Contribute' },
    { area: 'File an upstream integration issue', link: 'https://github.com/m7amedenho/frappe-studio/issues' },
    { area: 'Compare two upstream points visually', link: 'https://github.com/microsoft/vscode/compare' },
];

/*---------------------------------------------------------------------------------------------*
 * Files & JSON
 *---------------------------------------------------------------------------------------------*/

/** Defensive JSONC stripper (line + block comments), string- and escape-aware. */
export function stripJsonComments(text) {
    let out = '';
    let i = 0;
    let inString = false;
    let stringQuote = '"';
    while (i < text.length) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === '\\') {
                // Copy the escape sequence verbatim (guard against truncation).
                out += text[i + 1] ?? '';
                i += 2;
                continue;
            }
            if (c === stringQuote) {
                inString = false;
            }
            i += 1;
            continue;
        }
        if (c === '"' || c === "'") {
            inString = true;
            stringQuote = c;
            out += c;
            i += 1;
            continue;
        }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') { i += 1; }
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i += 1; }
            i += 2; // skip '*/'
            continue;
        }
        out += c;
        i += 1;
    }
    return out;
}

export function readJsonFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    let json = text;
    try {
        return JSON.parse(json);
    } catch {
        json = stripJsonComments(text);
        return JSON.parse(json); // throws with a clean parse error if truly invalid
    }
}

export function readJsonFileSyncSafe(file) {
    try {
        return readJsonFile(file);
    } catch {
        return undefined;
    }
}

export function writeJsonFile(file, value, { indent = 2 } = {}) {
    const text = JSON.stringify(value, null, indent) + '\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    return text;
}

/** Load scripts/upstream/config.json and validate the shape we depend on. */
export function loadConfig(file = CONFIG_PATH) {
    const cfg = readJsonFile(file); // throws with message on invalid JSON
    const required = [
        'upstreamRemote', 'upstreamRef', 'forkRemote', 'mainBranch', 'upstreamBaseCommit',
        'upstreamBaseTagRef', 'syncBranchPrefix', 'protectedPaths',
        'mechanicallyResolvableConflictKinds', 'maxCommitsBehindBeforeWarning',
    ];
    const missing = required.filter((key) => !(key in cfg));
    if (missing.length > 0) {
        throw new Error(`config.json is missing required keys: ${missing.join(', ')}`);
    }
    return cfg;
}

/*---------------------------------------------------------------------------------------------*
 * Dates (deterministic, TZ-aware) — used for branch names and report file names.
 *---------------------------------------------------------------------------------------------*/

/**
 * Format an instant as `yyyyMMdd` in the given IANA time zone (default UTC).
 * Pure: exported so selftest can verify TZ determinism without any env/local setup.
 */
export function formatLocalDate(date, timeZone = 'UTC') {
    const parts = getPaddedParts(date, timeZone);
    return `${parts.year}${parts.month}${parts.day}`;
}

/** Format an instant as `yyyyMMdd-HHmmss` in the given IANA time zone (default UTC). */
export function formatFileTimestamp(date, timeZone = 'UTC') {
    const p = getPaddedParts(date, timeZone);
    return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

function getPaddedParts(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const out = {};
    for (const part of dtf.formatToParts(date)) {
        if (part.type !== 'literal') { out[part.type] = part.value; }
    }
    // Strip a possible explicit year sign ('u+n'); en-GB 4-digit years have no sign.
    const year = out.year.replace(/^u[-+]?\+?/, '').padStart(4, '0');
    return {
        year,
        month: out.month.padStart(2, '0'),
        day: out.day.padStart(2, '0'),
        hour: out.hour.padStart(2, '0'),
        minute: out.minute.padStart(2, '0'),
        second: out.second.padStart(2, '0'),
    };
}

/** `upstream-sync-20260131` — deterministic per date + time zone. */
export function syncBranchName(prefix, date, timeZone = 'UTC') {
    return `${prefix}-${formatLocalDate(date, timeZone)}`;
}

/*---------------------------------------------------------------------------------------------*
 * Git helpers (safe-args only; never string-concatenated user input into a shell)
 *---------------------------------------------------------------------------------------------*/

export function runGit(args, { cwd = ROOT, input } = {}) {
    const res = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        input,
    });
    const ok = res.status === 0 && !res.error;
    return { ok, status: res.status ?? -1, stdout: (res.stdout ?? ''), stderr: (res.stderr ?? ''), error: res.error?.message };
}

export function runGitOrThrow(args, label, opts) {
    const res = runGit(args, opts);
    if (!res.ok) {
        const detail = res.stderr.trim() || res.stdout.trim() || `exit code ${res.status}`;
        throw new Error(`git ${args.join(' ')} failed${label ? ` (${label})` : ''}: ${detail}`);
    }
    return res.stdout.trim();
}

/** True when the commit object exists locally (any ref, loose or packed). */
export function gitHasCommit(sha, cwd = ROOT) {
    if (!/^[0-9a-f]{40}$/i.test(sha) && !/^[0-9a-f]{7,40}$/i.test(sha)) { return false; }
    return runGit(['cat-file', '-e', `${sha}^{commit}`], { cwd }).ok;
}

/**
 * Make sure the base commit object is present locally; fetch it from the remote
 * (fetching a bare SHA is supported by GitHub) when needed. Non-mutating except
 * for adding objects/refs to FETCH_HEAD.
 */
export function ensureCommitExists(sha, remote, cwd = ROOT) {
    if (gitHasCommit(sha, cwd)) { return true; }
    if (remote) {
        runGit(['fetch', '--no-tags', remote, sha], { cwd });
        return gitHasCommit(sha, cwd);
    }
    return false;
}

/** Number of commits in `tip` that are not in `base` (`git rev-list --count base..tip`). */
export function countCommitsBehind(base, tip, cwd = ROOT) {
    const out = runGit(['rev-list', '--count', `${base}..${tip}`], { cwd });
    if (!out.ok) { return NaN; }
    const n = Number.parseInt(out.stdout.trim(), 10);
    return Number.isNaN(n) ? NaN : n;
}

/**
 * Files changed between `base` and `tip` (three-dot: `base...tip`).
 * When `base` is an ancestor of `tip` this is exactly the set of files the new
 * upstream commits touch; three-dot stays meaningful even after fork work.
 */
export function changedFilesBetween(base, tip, cwd = ROOT) {
    const out = runGit(['diff', '--name-only', `${base}...${tip}`], { cwd });
    if (!out.ok) { return null; }
    return toLines(out.stdout);
}

function toLines(text) {
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Parse a `git status --porcelain` output; return only conflict entries. */
export function conflictsFromPorcelain(porcelainText) {
    const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
    const result = [];
    for (const line of toLines(porcelainText)) {
        if (line.length < 4) { continue; }
        const code = line.slice(0, 2);
        let filePath = line.slice(3);
        // Rename/copy conflicts show as `X -> Y`; the conflict is about both sides.
        const arrow = filePath.indexOf(' -> ');
        if (arrow !== -1) { filePath = filePath.slice(arrow + 4); }
        if (conflictCodes.has(code)) {
            result.push({ code, path: filePath });
        }
    }
    return result;
}

/*---------------------------------------------------------------------------------------------*
 * Protected paths & conflict decisions (pure, testable)
 *---------------------------------------------------------------------------------------------*/

function normalize(p) {
    return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * `true` when `relPath` *is* a protected path or lives inside one.
 * Prefix matching is directory-aware: `frappeStudioX` is NOT `frappeStudio`.
 * Pure.
 */
export function isProtectedPath(relPath, protectedPaths) {
    const p = normalize(relPath);
    return (protectedPaths ?? []).some((entry) => {
        const prefix = normalize(entry);
        return p === prefix || p.startsWith(`${prefix}/`);
    });
}

/**
 * Infer the *kind* of a conflicted file for the decision table.
 * Pure. Workbench TS/JS sources and module entry points are dominated by
 * import-ordering changes; everything else is most often whitespace.
 */
export function inferConflictKind(relPath) {
    const p = normalize(relPath);
    if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(p)) { return 'import-order'; }
    return 'whitespace';
}

/**
 * Decide how a conflicted file must be handled. Returns a full record for the
 * conflict report. Pure.
 *
 * Decision table (`autoResolve` is ALWAYS false — see CONFLICT_POLICY):
 * | path                    | kind                | action              |
 * |-------------------------|---------------------|---------------------|
 * | protected path          | any                 | manual              |
 * | unprotected             | mechanical kind     | manual-with-tooling |
 * | unprotected             | other kind          | manual              |
 */
export function decideConflictAction(relPath, options) {
    const { protectedPaths = [], mechanicallyResolvableConflictKinds = [] } = options ?? {};
    const kind = inferConflictKind(relPath);
    const isProtected = isProtectedPath(relPath, protectedPaths);
    const isMechanicalKind = mechanicallyResolvableConflictKinds.includes(kind);

    let action;
    let reason;
    if (isProtected) {
        action = 'manual';
        reason = 'Path is inside a protected path owned by the fork; a human must read both sides.';
    } else if (isMechanicalKind) {
        action = 'manual-with-tooling';
        reason = `Kind "${kind}" is mechanically resolvable; a human may fix it with tooling and must review the result.`;
    } else {
        action = 'manual';
        reason = `Kind "${kind}" has no mechanical resolution; resolve by hand.`;
    }

    return {
        path: normalize(relPath),
        kind,
        isProtected,
        protectedPath: isProtected
            ? (protectedPaths ?? []).find((entry) => {
                const prefix = normalize(entry);
                const p = normalize(relPath);
                return p === prefix || p.startsWith(`${prefix}/`);
            }) ?? null
            : null,
        action,
        autoResolve: false,
        reason,
    };
}

/** Group file paths by their top-level directory for the report. Pure. */
export function groupByTopDir(files) {
    const grouped = new Map();
    for (const f of files ?? []) {
        const normalized = normalize(f);
        const top = normalized.includes('/') ? normalized.split('/')[0] : '(root)';
        if (!grouped.has(top)) { grouped.set(top, []); }
        grouped.get(top).push(normalized);
    }
    return grouped;
}

/*---------------------------------------------------------------------------------------------*
 * Report generation (pure: returns strings; caller writes files)
 *---------------------------------------------------------------------------------------------*/

/** Human shortlist of conflict rows with protected-path flags and guidance. Pure. */
export function conflictReportMarkdown({ generatedAtIso, baseCommit, tipCommit, branchName, conflicts, config }) {
    const decisions = conflicts.map((c) => decideConflictAction(c.path, config));
    const lines = [];
    lines.push(`# Upstream sync conflict report`);
    lines.push('');
    lines.push(`- Generated: ${generatedAtIso}`);
    lines.push(`- Upstream base: \`${baseCommit}\``);
    lines.push(`- Upstream tip: \`${tipCommit ?? 'unknown'}\``);
    lines.push(`- Branch: \`${branchName}\` (merge aborted; branch left in place for inspection)`);
    lines.push('');
    lines.push(CONFLICT_POLICY);
    lines.push('');
    lines.push(`## Conflicted files (${conflicts.length})`);
    lines.push('');
    if (conflicts.length === 0) {
        lines.push('(none — the merge failed for a different reason; see the CLI output above)');
    } else {
        lines.push(`| Status | File | Protected path | Kind | Required action |`);
        lines.push(`|--------|------|----------------|------|-----------------|`);
        for (const d of decisions) {
            lines.push(`| ${conflicts.find((c) => c.path === d.path)?.code ?? '??'} | \`${d.path}\` | ${d.protectedPath ? `\`${d.protectedPath}\`` : '—'} | ${d.kind} | **${d.action}** |`);
        }
        lines.push('');
        lines.push(`### Per-file guidance`);
        lines.push('');
        for (const d of decisions) {
            lines.push(`- \`${d.path}\`: ${d.reason}`);
        }
    }
    lines.push('');
    lines.push(`## Doc guidance`);
    lines.push('');
    lines.push(`| Area | Guidance |`);
    lines.push(`|------|----------|`);
    for (const entry of DOC_LINKS) {
        lines.push(`| ${entry.area} | ${entry.link} |`);
    }
    lines.push('');
    return lines.join('\n') + '\n';
}
