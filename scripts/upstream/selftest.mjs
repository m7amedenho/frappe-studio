/*---------------------------------------------------------------------------------------------
 * frappe-studio: upstream tooling — pure unit tests (no mocha, plain node:assert)
 * Run with:  node scripts/upstream/selftest.mjs
 * Requires no git binary and no network: everything here is pure JS over lib.mjs + config.json.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {
    ROOT, CONFIG_PATH,
    loadConfig, stripJsonComments,
    formatLocalDate, syncBranchName,
    conflictsFromPorcelain, conflictReportMarkdown,
    isProtectedPath, inferConflictKind, decideConflictAction,
    groupByTopDir,
} from './lib.mjs';

/** Fixed instant used across TZ determinism tests:
 * UTC 2026-11-07 00:30 | Los Angeles 2026-11-06 17:30 | Karachi 2026-11-07 05:30 */
const FIXED_INSTANT = new Date('2026-11-07T00:30:00Z');

const results = [];

function test(name, fn) {
    try {
        fn();
        console.log(`PASS ${name}`);
        results.push({ name, ok: true });
    } catch (err) {
        console.error(`FAIL ${name}`);
        console.error(`  ${err?.stack ?? err?.message ?? String(err)}`);
        results.push({ name, ok: false, error: err });
    }
}

function fail(message) {
    assert.fail(message);
}

/*---------------------------------------------------------------------------------------------*
 * 1. Config parsing
 *---------------------------------------------------------------------------------------------*/

test('config: scripts/upstream/config.json parses and matches the required shape', () => {
    const cfg = loadConfig(CONFIG_PATH); // throws on invalid JSON or missing keys
    assert.equal(cfg.upstreamRemote, 'upstream');
    assert.equal(cfg.upstreamRef, 'main');
    assert.equal(cfg.forkRemote, 'origin');
    assert.equal(cfg.mainBranch, 'main');
    assert.equal(cfg.upstreamBaseCommit, '1745a4a6102e93173430b4b2debc1247a91cd036');
    assert.equal(cfg.upstreamBaseTagRef, 'refs/frappe-studio/upstream-base');
    assert.equal(cfg.syncBranchPrefix, 'upstream-sync');
    assert.deepEqual(cfg.protectedPaths, [
        'src/vs/workbench/contrib/frappeStudio',
        'docs/upstream',
        'scripts/upstream',
        '.github/workflows',
    ]);
    assert.deepEqual(cfg.mechanicallyResolvableConflictKinds, ['whitespace', 'import-order']);
    assert.equal(cfg.maxCommitsBehindBeforeWarning, 500);
});

test('config: loadConfig throws a descriptive error when required keys are missing', () => {
    const tempPath = path.join(ROOT, 'scripts', 'upstream', '.selftest-config.tmp.json');
    try {
        fs.writeFileSync(tempPath, JSON.stringify({ upstreamRemote: 'upstream' }), 'utf8');
        try {
            loadConfig(tempPath);
            fail('expected loadConfig to throw for missing keys');
        } catch (err) {
            assert.ok(/missing required keys/.test(err.message), `unexpected error: ${err.message}`);
        }
    } finally {
        try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort cleanup */ }
    }
});

test('config: stripJsonComments removes comments while keeping strings and escapes intact', () => {
    const example = '{\n  // line comment\n  "a": "http://not-a-comment", /* block */ "b": 2 \n}\n';
    assert.deepEqual(JSON.parse(stripJsonComments(example)), { a: 'http://not-a-comment', b: 2 });
    assert.deepEqual(JSON.parse(stripJsonComments('"neither a comment // here"')), 'neither a comment // here');
    assert.deepEqual(JSON.parse(stripJsonComments('"escaped \\" stays"')), 'escaped " stays');
    assert.deepEqual(JSON.parse(stripJsonComments('{"a": "/* not a block */"}')), { a: '/* not a block */' });
});

/*---------------------------------------------------------------------------------------------*
 * 2. Merge-branch name generation (deterministic per date with TZ)
 *---------------------------------------------------------------------------------------------*/

test('branch name: deterministic per instant in UTC', () => {
    assert.equal(syncBranchName('upstream-sync', FIXED_INSTANT, 'UTC'), 'upstream-sync-20261107');
    assert.equal(syncBranchName('upstream-sync', new Date('2026-11-07T23:59:59Z'), 'UTC'), 'upstream-sync-20261107');
    assert.equal(syncBranchName('upstream-sync', new Date('2026-11-08T00:00:00Z'), 'UTC'), 'upstream-sync-20261108');
});

test('branch name: deterministic per instant under a different time zone', () => {
    // The same instant, expressed in America/Los_Angeles, is the previous calendar day.
    assert.equal(syncBranchName('upstream-sync', FIXED_INSTANT, 'America/Los_Angeles'), 'upstream-sync-20261106');
    // Asia/Karachi (UTC+5) is still 2026-11-07 at that instant.
    assert.equal(syncBranchName('upstream-sync', FIXED_INSTANT, 'Asia/Karachi'), 'upstream-sync-20261107');
    assert.equal(formatLocalDate(FIXED_INSTANT, 'America/Los_Angeles'), '20261106');
});

test('branch name: respects the configured prefix pattern `<prefix>-<yyyyMMdd>`', () => {
    assert.equal(syncBranchName('upstream-sync', FIXED_INSTANT, 'UTC').startsWith('upstream-sync-'), true);
    assert.equal(syncBranchName('fb-sync', FIXED_INSTANT, 'UTC'), 'fb-sync-20261107');
});

/*---------------------------------------------------------------------------------------------*
 * 3. Conflict-report generation from a synthetic `git status --porcelain`
 *---------------------------------------------------------------------------------------------*/

const SYNTHETIC_PORCELAIN = [
    'UU src/vs/workbench/workbench.common.main.ts',
    'AA src/vs/workbench/contrib/frappeStudio/editors/doctypeEditorController.ts',
    'DU src/vs/base/common/labels.ts',
    'UU scripts/upstream/config.json',
    ' M product.json',          // plain modification: NOT a conflict
    '?? scratch.txt',            // untracked: NOT a conflict
    'A  src/vs/workbench/contrib/frappeStudio/common/foo.ts', // staged add: NOT a conflict
].join('\n') + '\n';

test('conflict parse: only conflict codes are extracted from porcelain output', () => {
    const conflicts = conflictsFromPorcelain(SYNTHETIC_PORCELAIN);
    assert.deepEqual(conflicts.map((c) => `${c.code}:${c.path}`), [
        'UU:src/vs/workbench/workbench.common.main.ts',
        'AA:src/vs/workbench/contrib/frappeStudio/editors/doctypeEditorController.ts',
        'DU:src/vs/base/common/labels.ts',
        'UU:scripts/upstream/config.json',
    ]);
});

test('conflict parse: empty porcelain yields no conflicts', () => {
    assert.deepEqual(conflictsFromPorcelain(''), []);
    assert.deepEqual(conflictsFromPorcelain('\n\n'), []);
});

test('conflict parse: rename conflicts use the post-rename side', () => {
    const conflicts = conflictsFromPorcelain('UU old/name.ts -> new/name.ts\n');
    assert.deepEqual(conflicts, [{ code: 'UU', path: 'new/name.ts' }]);
});

test('conflict report: generated markdown carries policy, protected flags, and guidance', () => {
    const conflicts = conflictsFromPorcelain(SYNTHETIC_PORCELAIN);
    const config = loadConfig(CONFIG_PATH);
    const md = conflictReportMarkdown({
        generatedAtIso: '2026-11-07T10:00:00.000Z',
        baseCommit: config.upstreamBaseCommit,
        tipCommit: 'abc1234567890abcdef1234567890abcdef123456',
        branchName: 'upstream-sync-20261107',
        conflicts,
        config,
    });

    assert.ok(md.startsWith('# Upstream sync conflict report'), 'report must have a title');
    assert.ok(md.includes('## CONFLICT POLICY'), 'report embeds the conflict policy');
    assert.ok(/never auto-?resolve/i.test(md), 'policy must state that conflicts are never auto-resolved');

    for (const c of conflicts) {
        assert.ok(md.includes(c.path), `report lists conflicted file ${c.path}`);
    }
    assert.ok(md.includes('src/vs/workbench/contrib/frappeStudio'), 'protected path is visible in the table');
    assert.ok(md.includes('upstream-sync-20261107'), 'report mentions the branch');
    assert.ok(md.includes('2026-11-07T10:00:00.000Z'), 'report has the generation timestamp');

    const decisionRow = decideConflictAction('scripts/upstream/config.json', config);
    assert.equal(decisionRow.action, 'manual');
    assert.equal(decisionRow.protectedPath, 'scripts/upstream');

    assert.ok(md.includes('|------|'), 'markdown tables render (header separator)');
});

test('conflict report: markdown table marks every action as manual (never auto)', () => {
    const conflicts = conflictsFromPorcelain('UU sample.ts\n');
    const config = loadConfig(CONFIG_PATH);
    const md = conflictReportMarkdown({
        generatedAtIso: '2026-11-07T10:00:00.000Z',
        baseCommit: config.upstreamBaseCommit,
        tipCommit: 'abc1234567890abcdef1234567890abcdef123456',
        branchName: 'upstream-sync-20261107',
        conflicts,
        config,
    });
    assert.ok(md.includes('manual-with-tooling'), 'mechanical kind row shows tooling-assisted manual action');
    assert.ok(!/auto-resolve:\s*true|action:\s*auto/i.test(md), 'no row may suggest automatic resolution');
});

/*---------------------------------------------------------------------------------------------*
 * 4. Protected-path detection for sample paths
 *---------------------------------------------------------------------------------------------*/

const CONFIG = loadConfig(CONFIG_PATH);

test('protected paths: exact files and directories inside protected roots are detected', () => {
    const samples = [
        ['src/vs/workbench/contrib/frappeStudio/connection/frappeClient.ts', true],
        ['src/vs/workbench/contrib/frappeStudio', true],                      // the root itself
        ['src/vs/workbench/contrib/frappeStudio/', true],                     // trailing slash tolerated
        ['docs/upstream/guide.md', true],
        ['docs/upstream', true],
        ['scripts/upstream/upstream.mjs', true],
        ['scripts/upstream/lib.mjs', true],
        ['.github/workflows/build.yml', true],
        ['.github/workflows', true],
        ['src\\vs\\workbench\\contrib\\frappeStudio\\connection\\frappeClient.ts', true], // normalized
    ];
    for (const [p, expected] of samples) {
        assert.equal(isProtectedPath(p, CONFIG.protectedPaths), expected, `${p} -> ${expected}`);
    }
});

test('protected paths: similar-but-distinct paths are NOT protected', () => {
    const samples = [
        ['src/vs/workbench/contrib/frappeStudioX/a.ts', false],  // prefix must not swallow siblings
        ['src/vs/workbench/contrib/frappStudy/a.ts', false],
        ['src/vs/base/common/map.ts', false],
        ['src/vs/workbench/workbench.common.main.ts', false],    // integration file, but not in config list
        ['.github/workflowsx/evil.yml', false],
        ['.github/ISSUE_TEMPLATE/x.md', false],
        ['scripts/upstream-tools/run.sh', false],
        ['docs/upstream-downstream.md', false],
    ];
    for (const [p, expected] of samples) {
        assert.equal(isProtectedPath(p, CONFIG.protectedPaths), expected, `${p} -> ${expected}`);
    }
});

/*---------------------------------------------------------------------------------------------*
 * 5. Decision table: mechanical vs manual conflicts
 *---------------------------------------------------------------------------------------------*/

test('decision table: protected paths are always manual, regardless of kind', () => {
    const rows = [
        ['src/vs/workbench/contrib/frappeStudio/connection/frappeClient.ts', 'import-order'],
        ['scripts/upstream/config.json', 'whitespace'],
        ['.github/workflows/build.yml', 'whitespace'],
        ['src/vs/workbench/contrib/frappeStudio/editors/x.ts', 'import-order'],
    ];
    for (const [p, kind] of rows) {
        const decision = decideConflictAction(p, CONFIG);
        assert.equal(decision.action, 'manual', `${p} must be manual`);
        assert.equal(decision.autoResolve, false, `${p} must never auto-resolve`);
        assert.equal(decision.isProtected, true);
        assert.equal(decision.kind, kind);
        assert.ok(decision.protectedPath, `${p} must name its owning protected path`);
    }
});

test('decision table: unprotected mechanical kinds map to manual-with-tooling (still never auto)', () => {
    for (const p of [
        'src/vs/base/common/labels.ts',                 // import-order kind
        'src/vs/workbench/workbench.common.main.ts',    // import-order kind, not protected by config
    ]) {
        const decision = decideConflictAction(p, CONFIG);
        assert.equal(decision.kind, 'import-order');
        assert.equal(decision.isProtected, false);
        assert.equal(decision.action, 'manual-with-tooling', `${p}: mechanical kind -> human + tooling`);
        assert.equal(decision.autoResolve, false, `${p} must never auto-resolve`);
    }
    for (const p of ['build/transpile.js', 'src/vs/platform/browser/view.ts']) {
        const decision = decideConflictAction(p, CONFIG);
        assert.equal(decision.kind, 'import-order');
        assert.equal(decision.action, 'manual-with-tooling');
        assert.equal(decision.autoResolve, false);
    }
});

test('decision table: non-source kinds fall back to whitespace (mechanical) and are tool-assisted', () => {
    for (const p of ['README.md', 'docs/some-guide.md', 'product.json', 'Makefile', 'src/temp/story.txt']) {
        const decision = decideConflictAction(p, CONFIG);
        assert.equal(decision.kind, 'whitespace', `${p} -> whitespace kind`);
        assert.equal(decision.action, 'manual-with-tooling', `${p} kind is in mechanicallyResolvableConflictKinds`);
        assert.equal(decision.autoResolve, false, `${p} still never auto-resolves`);
    }
});

test('decision table: the invariant autoResolve === false holds for every sample', () => {
    const samples = [
        'src/vs/workbench/contrib/frappeStudio/connection/frappeClient.ts',
        'src/vs/workbench/workbench.common.main.ts',
        'src/vs/base/common/labels.ts',
        'scripts/upstream/config.json',
        '.github/workflows/build.yml',
        'docs/upstream/notes.md',
        'README.md',
        'build/gulpfile.extensions.js',
        'package.json',
        'product.json',
    ];
    for (const p of samples) {
        assert.equal(decideConflictAction(p, CONFIG).autoResolve, false, `${p}`);
    }
});

test('inference: inferConflictKind classifies by file extension', () => {
    assert.equal(inferConflictKind('a/b/c.ts'), 'import-order');
    assert.equal(inferConflictKind('a/b/c.mjs'), 'import-order');
    assert.equal(inferConflictKind('a/b/c.jsx'), 'import-order');
    assert.equal(inferConflictKind('a/b/c.MD'), 'whitespace');
    assert.equal(inferConflictKind('a/b/c'), 'whitespace');
});

/*---------------------------------------------------------------------------------------------*
 * 6. Grouping helper
 *---------------------------------------------------------------------------------------------*/

test('grouping: changed files group by top-level directory', () => {
    const grouped = groupByTopDir([
        'src/vs/base/common/map.ts',
        'src/vs/platform/actions/common/menu.ts',
        'package.json',
    ]);
    assert.ok(grouped instanceof Map);
    assert.deepEqual([...grouped.keys()].sort(), ['(root)', 'src']);
    assert.equal(grouped.get('src').length, 2);
    assert.equal(grouped.get('(root)')[0], 'package.json');
});

test('grouping: empty input yields an empty map', () => {
    assert.equal(groupByTopDir([]).size, 0);
});

/*---------------------------------------------------------------------------------------------*
 * Summary
 *---------------------------------------------------------------------------------------------*/

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`selftest summary: ${results.length - failed.length} passed, ${failed.length} failed, total ${results.length}`);
if (failed.length > 0) {
    for (const f of failed) { console.error(`FAILED: ${f.name}`); }
    process.exit(1);
}
process.exit(0);
