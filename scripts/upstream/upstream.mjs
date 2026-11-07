#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * frappe-studio: upstream synchronization CLI
 * Copyright (c) Frappe Studio contributors. MIT License.
 *
 * Zero-dependency Node 24+ ESM CLI:
 *   node scripts/upstream/upstream.mjs <check|status|fetch|report|sync|test> [--help]
 *
 * See scripts/upstream/README.md for the full documentation.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
    ROOT, CONFIG_PATH, STATUS_PATH, REPORT_DIR,
    readJsonFileSyncSafe, writeJsonFile, loadConfig,
    runGit, runGitOrThrow, ensureCommitExists, gitHasCommit,
    countCommitsBehind, changedFilesBetween,
    conflictsFromPorcelain, conflictReportMarkdown,
    isProtectedPath, groupByTopDir,
    syncBranchName, formatFileTimestamp,
    DOC_LINKS, CONFLICT_POLICY,
} from './lib.mjs';

const SELF_PATH = path.join(ROOT, 'scripts', 'upstream', 'upstream.mjs');

/*---------------------------------------------------------------------------------------------*
 * Small helpers
 *---------------------------------------------------------------------------------------------*/

function die(message, code = 1) {
    console.error(`error: ${message}`);
    process.exit(code);
}

function rel(p) {
    return path.relative(ROOT, p).replace(/\\/g, '/');
}

function git(args, label) {
    return runGitOrThrow(args, label, { cwd: ROOT });
}

function tryGit(args) {
    return runGit(args, { cwd: ROOT });
}

function readConfig() {
    try {
        return loadConfig(CONFIG_PATH);
    } catch (err) {
        die(`could not load scripts/upstream/config.json: ${err.message}`, 4);
    }
}

function safeFetch(args, { fast = false } = {}) {
    const argsWithRetry = fast ? ['--depth=2147483647', ...args] : [...args];
    let res = tryGit(argsWithRetry);
    if (fast && !res.ok) {
        // Shallow fetch of the remote can be rejected by some servers; retry unshallow-free.
        res = tryGit(args);
    }
    return res;
}

/** Resolve the current upstream tip and make sure the recorded base exists locally. */
function resolveUpstreamRefs(cfg) {
    const remote = cfg.upstreamRemote;
    const ref = `${remote}/${cfg.upstreamRef}`;
    const tip = git(['rev-parse', ref], `resolve ${ref}`);
    const base = cfg.upstreamBaseCommit;
    const okBase = ensureCommitExists(base, remote);
    if (!okBase) {
        die(`recorded upstream base commit ${base} does not exist locally and could not be fetched from ${remote}. ` +
            `Run 'git fetch ${remote}' manually.`, 4);
    }
    return { remote, ref, tip, base };
}

function storeStatus({ base, tip, behind, branch, clean, refLabel }) {
    const previous = readJsonFileSyncSafe(STATUS_PATH) ?? {};
    const status = {
        ...previous,
        lastChecked: new Date().toISOString(),
        upstreamBaseCommit: base,
        upstreamTip: tip,
        upstreamRef: refLabel ?? previous.upstreamRef ?? 'upstream/main',
        behindCount: behind ?? previous.behindCount ?? null,
        currentBranch: branch ?? previous.currentBranch ?? null,
        workingTreeDirty: typeof clean === 'boolean' ? !clean : previous.workingTreeDirty ?? null,
    };
    writeJsonFile(STATUS_PATH, status);
    return status;
}

function cleanWorkingTree({ allowUntracked = true } = {}) {
    const out = git(['status', '--porcelain'], 'status');
    const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const blocking = lines.filter((l) => l.startsWith('??') ? !allowUntracked : true);
    return { clean: blocking.length === 0, lines, blocking };
}

function currentBranch() {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], 'current branch');
}

function mergeInProgress() {
    return tryGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok;
}

/** Best-effort "go back to main" without ever discarding product changes. */
function restoreMain(cfg) {
    if (mergeInProgress()) {
        console.log('merging is in progress: aborting the merge (no resolution is discarded; merge state only)');
        tryGit(['merge', '--abort']);
    }
    const br = currentBranch();
    if (br === cfg.mainBranch) {
        return true;
    }
    const res = tryGit(['checkout', cfg.mainBranch]);
    if (res.ok) {
        console.log(`restored: checked out branch '${cfg.mainBranch}' (the sync branch was left in place for inspection)`);
        return true;
    }
    console.error(`warning: could not checkout '${cfg.mainBranch}': ${res.stderr.trim() || res.stdout.trim()}`);
    return false;
}

function pnpmAvailable() {
    const probe = spawnSync('pnpm', ['--version'], { cwd: ROOT, encoding: 'utf8' });
    return probe.status === 0 && !probe.error;
}

function packageJsonHasScript(name) {
    const pkg = readJsonFileSyncSafe(path.join(ROOT, 'package.json'));
    return Boolean(pkg?.scripts?.[name]);
}

/*---------------------------------------------------------------------------------------------*
 * Commands
 *---------------------------------------------------------------------------------------------*/

/** Compute drift facts (shared by check / status / report / sync). */
function driftFacts(cfg, { whatIfTip } = {}) {
    const { remote, ref, tip, base } = resolveUpstreamRefs(cfg);
    const tipCommit = whatIfTip ?? tip;
    const behind = countCommitsBehind(base, tipCommit);
    const changedFiles = changedFilesBetween(base, tipCommit) ?? [];
    const protectedHits = changedFiles.filter((f) => isProtectedPath(f, cfg.protectedPaths));
    return { remote, ref, tip: tipCommit, base, behind, changedFiles, protectedHits };
}

/** Conservative, scoped fetch of `refs/heads/<ref>:refs/remotes/<remote>/<ref>`. */
function fetchUpstream(cfg) {
    const spec = `refs/heads/${cfg.upstreamRef}:refs/remotes/${cfg.upstreamRemote}/${cfg.upstreamRef}`;
    let res = tryGit(['fetch', '--prune', '--filter=blob:none', cfg.upstreamRemote, spec]);
    if (!res.ok) {
        res = tryGit(['fetch', '--prune', cfg.upstreamRemote, spec]);
    }
    if (!res.ok) {
        // Last resort: the default (all-branch) fetch.
        res = tryGit(['fetch', '--prune', cfg.upstreamRemote]);
    }
    return res;
}

function cmdCheck(cfg) {
    const res = fetchUpstream(cfg);
    if (!res || !res.ok) {
        const detail = res ? (res.stderr.trim() || res.stdout.trim() || `exit code ${res.status}`) : 'unexpected error';
        console.error(`error: could not fetch upstream: ${detail}`);
        storeStatus({ base: cfg.upstreamBaseCommit, tip: null, behind: null, branch: null, clean: false });
        process.exit(3);
    }

    const facts = driftFacts(cfg);
    const behindCapped = Number.isNaN(facts.behind) ? null : facts.behind;
    console.log(`upstream base : ${facts.base}`);
    console.log(`upstream tip  : ${facts.tip} (${facts.ref})`);
    console.log(`behind count  : ${behindCapped ?? 'unknown'}`);
    console.log(`changed files : ${facts.changedFiles.length}`);
    if (behindCapped === 0) {
        console.log('drift         : none — upstream base matches the tip');
        storeStatus({ base: facts.base, tip: facts.tip, behind: 0, branch: null, clean: true });
        return 0;
    }

    console.log('drift         : yes — new upstream commits detected');
    if (behindCapped !== null && behindCapped > cfg.maxCommitsBehindBeforeWarning) {
        console.log(`warning: ${behindCapped} new commits is more than maxCommitsBehindBeforeWarning=${cfg.maxCommitsBehindBeforeWarning}; plan the sync in batches`);
    }
    if (facts.protectedHits.length > 0) {
        console.log('protected-path changes upstream (the sync WILL require manual review):');
        for (const f of facts.protectedHits) {
            console.log(`  ${f}`);
        }
        console.log('(exit code 2: drift touches protected paths)');
        storeStatus({ base: facts.base, tip: facts.tip, behind: facts.behind, branch: null, clean: true });
        return 2;
    }
    // Exit code 1: plain drift, nothing touching protected paths yet.
    console.log('(exit code 1: drift, no protected-path changes)');
    storeStatus({ base: facts.base, tip: facts.tip, behind: facts.behind, branch: null, clean: true });
    return 1;
}

function cmdFetch(cfg) {
    const res = fetchUpstream(cfg);
    if (!res.ok) {
        console.error(`git fetch ${cfg.upstreamRemote} failed: ${(res.stderr || res.stdout || '').trim()}`);
        process.exit(3);
    }
    console.log(`fetched ${cfg.upstreamRemote}/${cfg.upstreamRef} (with --prune)`);
    return 0;
}

function cmdStatus(cfg) {
    const facts = driftFacts(cfg);
    const state = cleanWorkingTree();
    const branch = currentBranch();
    const porcelain = tryGit(['status', '--porcelain']).stdout ?? '';
    const pending = conflictsFromPorcelain(porcelain);
    const status = storeStatus({
        base: facts.base, tip: facts.tip, behind: facts.behind,
        branch, clean: state.clean && pending.length === 0,
    });

    console.log('frappe-studio upstream status');
    console.log('-----------------------------');
    console.log(`main branch          : ${cfg.mainBranch}`);
    console.log(`current branch       : ${branch}`);
    console.log(`upstream base        : ${facts.base}`);
    console.log(`upstream tip         : ${facts.tip} (${facts.ref})`);
    console.log(`behind by (commits)  : ${Number.isNaN(facts.behind) ? 'unknown' : facts.behind}`);
    console.log(`working tree         : ${state.clean ? 'clean' : `dirty (${state.lines.length} entries)`}`);
    console.log(`merge conflicts      : ${pending.length === 0 ? 'none pending' : pending.map((p) => `${p.code}:${p.path}`).join(', ')}`);
    console.log(`upstream files since base : ${facts.changedFiles.length}`);
    console.log(`last checked         : ${status.lastChecked} (recorded in scripts/upstream/.status.json)`);
    return 0;
}

function cmdReport(cfg) {
    fetchUpstream(cfg);
    const facts = driftFacts(cfg);
    const stamp = formatFileTimestamp(new Date());
    const file = path.join(REPORT_DIR, `${stamp}-upstream-report.md`);
    const shortstatOut = tryGit(['diff', '--shortstat', `${facts.base}...${facts.tip}`]);
    const shortstats = (shortstatOut.stdout ?? '').trim() || '(no textual diff — base matches tip)';
    const oneline = git(['log', '--oneline', '--no-decorate', `${facts.base}..${facts.tip}`], 'commit list');

    const lines = [];
    lines.push(`# Upstream report — ${facts.ref}`);
    lines.push('');
    lines.push(`- Generated: ${new Date().toISOString()}`);
    lines.push(`- Base (recorded in scripts/upstream/config.json): \`${facts.base}\``);
    lines.push(`- Tip: \`${facts.tip}\``);
    lines.push(`- New commits: ${facts.behind}`);
    lines.push(`- Shortstats (base...tip): \`${shortstats}\``);
    if (facts.behind > cfg.maxCommitsBehindBeforeWarning) {
        lines.push(`- > warning: ${facts.behind} new commits exceeds maxCommitsBehindBeforeWarning=${cfg.maxCommitsBehindBeforeWarning}`);
    }
    lines.push('');
    lines.push('## New commits (oneline)');
    lines.push('');
    if (oneline.length === 0) {
        lines.push('(none — already up to date)');
    } else {
        lines.push('```');
        const commitLines = oneline.split(/\r?\n/);
        for (const l of commitLines.slice(0, 300)) { lines.push(l); }
        if (commitLines.length > 300) { lines.push(`… (${commitLines.length - 300} more)`); }
        lines.push('```');
    }
    lines.push('');
    lines.push('## Changed files by top-level directory');
    lines.push('');
    const grouped = groupByTopDir(facts.changedFiles);
    if (grouped.size === 0) {
        lines.push('(none)');
    } else {
        for (const dir of [...grouped.keys()].sort()) {
            lines.push(`### ${dir} (${grouped.get(dir).length})`);
            lines.push('');
            for (const f of grouped.get(dir)) {
                const flag = isProtectedPath(f, cfg.protectedPaths) ? ' :rotating_light: PROTECTED' : '';
                lines.push(`- \`${f}\`${flag}`);
            }
            lines.push('');
        }
    }
    lines.push('## Doc guidance');
    lines.push('');
    lines.push('| Area | Guidance |');
    lines.push('|------|----------|');
    for (const entry of DOC_LINKS) { lines.push(`| ${entry.area} | ${entry.link} |`); }
    lines.push('');
    lines.push(CONFLICT_POLICY.replace('## CONFLICT POLICY', '## Conflict policy (reference)'));
    lines.push('');
    lines.push('## Compare links');
    lines.push('');
    lines.push(`- https://github.com/microsoft/vscode/compare/${facts.base.slice(0, 9)}...${facts.tip.slice(0, 9)}`);
    lines.push('');

    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    storeStatus({ base: facts.base, tip: facts.tip, behind: facts.behind, branch: null, clean: true });
    console.log(rel(file));
    return 0;
}

/** `upstream.mjs test` — integration self-checks before declaring sync success. */
function cmdTest(cfg, quiet = false) {
    const problems = [];
    const notes = [];

    // --- (a) fork's own changes relative to main -----------------------------
    const diffMain = tryGit(['diff', '--name-only', cfg.mainBranch]);
    if (!diffMain.ok) {
        problems.push(`could not diff against ${cfg.mainBranch}: ${diffMain.stderr.trim()}`);
    } else {
        const ownChanges = diffMain.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const allowedExact = new Set(['package.json', 'product.json']);
        const allowedPrefix = [
            'src/vs/workbench/contrib/frappeStudio/',
            'scripts/upstream/',
            '.github/',
            'docs/',
        ];
        // Upstream-inherited files can legitimately differ from main right after a merge;
        // recognize them so the allowlist check stays about *fork-authored* changes.
        let inherited = new Set();
        if (ownChanges.length > 0) {
            const facts = {
                base: cfg.upstreamBaseCommit,
            };
            const upstream = changedFilesBetween(facts.base, `${cfg.upstreamRemote}/${cfg.upstreamRef}`);
            if (upstream) { inherited = new Set(upstream); }
        }
        for (const f of ownChanges) {
            const normalized = f.replace(/\\/g, '/');
            if (allowedExact.has(normalized) || allowedPrefix.some((p) => normalized.startsWith(p))) { continue; }
            if (inherited.has(normalized)) {
                notes.push(`${normalized}: differs from ${cfg.mainBranch}, but the change originates upstream (inherited by the merge)`);
                continue;
            }
            problems.push(`fork-authored change outside the allowed set: ${normalized}`);
        }
        if (!quiet || problems.length > 0) {
            console.log(`diff vs ${cfg.mainBranch}: ${ownChanges.length} file(s)` +
                (inherited.size ? `; ${ownChanges.filter((f) => inherited.has(f)).length} inherited from upstream` : ''));
        }
    }

    // --- practical approximation of the integration seam check ---------------
    const contribDir = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'frappeStudio');
    const dirOk = fs.existsSync(contribDir) &&
        fs.readdirSync(contribDir, { recursive: true }).some((f) => String(f).endsWith('.ts'));
    if (!dirOk) {
        problems.push('src/vs/workbench/contrib/frappeStudio does not exist (or has no TypeScript source)');
    } else if (!quiet) {
        console.log('integration source present: src/vs/workbench/contrib/frappeStudio');
    }

    const mainFile = path.join(ROOT, 'src', 'vs', 'workbench', 'workbench.common.main.ts');
    if (fs.existsSync(mainFile)) {
        const text = fs.readFileSync(mainFile, 'utf8');
        const hasImport = /frappeStudio/i.test(text);
        if (!hasImport) {
            problems.push('src/vs/workbench/workbench.common.main.ts does not reference frappeStudio — ' +
                'the contribution import line is required before a sync can be declared successful');
        } else if (!quiet) {
            console.log('integration seam present: workbench.common.main.ts references frappeStudio');
        }
    } else {
        problems.push('src/vs/workbench/workbench.common.main.ts is missing');
    }

    // --- (b) pure unit tests --------------------------------------------------
    const selftest = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'upstream', 'selftest.mjs')], {
        cwd: ROOT, stdio: 'inherit', encoding: 'utf8',
    });
    if (selftest.status !== 0) {
        problems.push('scripts/upstream/selftest.mjs failed');
    }

    for (const n of notes) { console.log(`note: ${n}`); }
    if (problems.length > 0) {
        for (const p of problems) { console.error(`FAIL: ${p}`); }
        if (!quiet) { console.error('\ntest: FAILED'); }
        return 1;
    }
    if (!quiet) { console.log('\ntest: OK'); }
    return 0;
}

function cmdSync(cfg) {
    // 0) make sure upstream/<ref> is fetched and current
    console.log(`fetching ${cfg.upstreamRemote}/${cfg.upstreamRef} (scoped fetch)...`);
    const fetched = fetchUpstream(cfg);
    if (!fetched.ok) {
        console.error(`could not fetch upstream: ${(fetched.stderr || fetched.stdout || '').trim()}`);
        process.exit(3);
    }

    const { remote, ref, tip, base } = resolveUpstreamRefs(cfg);
    const dieAndRestore = (message, code = 1) => {
        restoreMain(cfg);
        die(message, code);
    };

    // 1) verify clean working tree --------------------------------------------
    const state = cleanWorkingTree({ allowUntracked: true });
    if (!state.clean) {
        console.error('working tree is not clean for a sync:');
        for (const l of state.blocking) { console.error(`  ${l}`); }
        console.error('(untracked files are allowed; commit or stash tracked changes first)');
        process.exit(1);
    }
    if (mergeInProgress()) {
        console.error('a merge is already in progress; run `git merge --abort` first (no auto-discarding).');
        process.exit(1);
    }
    if (currentBranch() !== cfg.mainBranch) {
        console.error(`sync must run from branch '${cfg.mainBranch}' (current: ${currentBranch()})`);
        process.exit(1);
    }

    // 2) record current base ---------------------------------------------------
    console.log(`recorded base: ${base}`);
    const behind = countCommitsBehind(base, tip);
    if (behind === 0) {
        console.log('upstream is already at the recorded base. nothing to sync.');
        storeStatus({ base, tip, behind: 0, branch: cfg.mainBranch, clean: true });
        return 0;
    }
    console.log(`upstream is ${behind} commit(s) ahead; syncing ${base.slice(0, 9)} -> ${tip.slice(0, 9)}`);

    // 3) create/checkout branch -------------------------------------------------
    const branchName = syncBranchName(cfg.syncBranchPrefix, new Date());
    const exists = tryGit(['rev-parse', '-q', '--verify', `refs/heads/${branchName}`]).ok;
    if (exists) {
        console.error(`branch '${branchName}' already exists — inspect/delete it first (do not force): ` +
            `git switch ${branchName}; git branch -D ${branchName} # only if confirmed`);
        process.exit(1);
    }
    git(['checkout', '-b', branchName], `create ${branchName}`);
    console.log(`created and checked out branch: ${branchName}`);

    // 4) attempt a real merge -----------------------------------------------------
    const shortTip = tip.slice(0, 9);
    let mergeRes = tryGit(['merge', '--no-ff', '--no-edit', '-m', `chore: sync upstream ${shortTip}`, tip]);
    if (!mergeRes.ok) {
        const porcelain = tryGit(['status', '--porcelain']).stdout ?? '';
        const conflicts = conflictsFromPorcelain(porcelain);
        if (conflicts.length === 0) {
            // Merge failed for a non-conflict reason — nothing to abort, but be safe.
            dieAndRestore(`git merge failed (not a conflict): ${(mergeRes.stderr || mergeRes.stdout || '').trim()}`, 1);
        }
        // abort the merge; never auto-resolve anything
        tryGit(['merge', '--abort']);
        const stamp = formatFileTimestamp(new Date());
        const reportPath = path.join(REPORT_DIR, `${stamp}-conflicts.md`);
        const md = conflictReportMarkdown({
            generatedAtIso: new Date().toISOString(),
            baseCommit: base,
            tipCommit: tip,
            branchName,
            conflicts,
            config: cfg,
        });
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        fs.writeFileSync(reportPath, md, 'utf8');
        restoreMain(cfg);
        console.error(`merge produced conflicts (policy: never auto-resolve). merge aborted.`);
        console.error(`conflict report: ${rel(reportPath)}`);
        console.error(`the branch '${branchName}' was left in place (it currently points at ${cfg.mainBranch}).`);
        process.exit(1);
    }
    console.log(`merge clean: ${head()}`);

    // 5) run tests --------------------------------------------------------------------
    const testStatus = runSelf(cloneConfig(cfg));
    if (testStatus !== 0) {
        console.error('tests after merge failed — the merge commit is kept on the branch, but the sync is NOT declared successful.');
        restoreMain(cfg);
        process.exit(1);
    }

    // 6) required checks: compile via pnpm when available ------------------------------
    const hasScript = packageJsonHasScript('typecheck-client');
    if (!pnpmAvailable() || !hasScript) {
        const reason = !pnpmAvailable()
            ? 'pnpm is not available in PATH'
            : 'package.json has no "typecheck-client" script';
        console.log(`warning: skipping 'pnpm run typecheck-client' — ${reason}`);
        console.log('         (maintainers MUST run it locally before publishing the PR)');
    } else {
        console.log(`running required checks: pnpm run typecheck-client`);
        const tc = spawnSync('pnpm', ['run', 'typecheck-client'], {
            cwd: ROOT, encoding: 'utf8', stdio: 'inherit', maxBuffer: 64 * 1024 * 1024,
        });
        if (tc.status !== 0 || tc.error) {
            console.error('typecheck-client failed — sync aborted cleanly (no pushing, no force, nothing discarded).');
            restoreMain(cfg);
            process.exit(1);
        }
    }

    // 7) update config + marker ref, and fold both into the merge commit (single commit)
    const newCfg = { ...cfg, upstreamBaseCommit: tip };
    writeJsonFile(CONFIG_PATH, newCfg);
    git(['add', 'scripts/upstream/config.json'], 'stage config');
    git(['update-ref', '-m', `frappe-studio upstream sync (${shortTip})`, cfg.upstreamBaseTagRef, tip], `update ${cfg.upstreamBaseTagRef}`);
    const amend = tryGit(['commit', '--amend', '--no-edit']);
    if (!amend.ok) {
        console.error(`could not fold the base-update into the merge commit: ${(amend.stderr || amend.stdout || '').trim()}`);
        console.error('the merge commit and config change are staged on the sync branch — fix up manually.');
        restoreMain(cfg);
        process.exit(1);
    }

    // 8) wrap up ---------------------------------------------------------------------
    const wroteStatus = storeStatus({ base: tip, tip, behind: 0, branch: branchName, clean: true });
    const syncReport = `synced upstream ${base.slice(0, 9)} -> ${tip.slice(0, 9)} on ${new Date().toISOString()}: ${behind} commits (branch ${branchName})\n`;
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.appendFileSync(path.join(REPORT_DIR, 'sync-history.log'), syncReport, 'utf8');
    void wroteStatus;

    console.log('');
    console.log(`sync successful on branch '${branchName}'`);
    console.log(`head: ${head()}`);
    console.log(`base marker ref updated: ${cfg.upstreamBaseTagRef} -> ${tip}`);
    console.log('');
    console.log('NEXT STEPS');
    console.log('----------');
    console.log(`1. Run any remaining local checks:  pnpm install && pnpm run typecheck-client`);
    console.log(`2. Push the branch yourself:        git push origin ${branchName}`);
    console.log(`3. Open a PR from '${branchName}' into '${cfg.mainBranch}' (never merge main automatically).`);
    console.log(`4. Push the marker ref once:        git push origin ${cfg.upstreamBaseTagRef}`);
    console.log('   (do NOT push to upstream, do NOT force-push anywhere)');
    console.log('');
    return 0;
}

function head() {
    return git(['rev-parse', '--short', 'HEAD'], 'head');
}

function runSelf(cfg) {
    const res = spawnSync(process.execPath, [SELF_PATH, 'test'], {
        cwd: ROOT, encoding: 'utf8', stdio: 'inherit', maxBuffer: 32 * 1024 * 1024,
    });
    if (res.error) {
        console.error(`failed to run ${SELF_PATH}: ${res.error.message}`);
        return 1;
    }
    return res.status ?? 1;
}

function cloneConfig(cfg) {
    return JSON.parse(JSON.stringify(cfg));
}

/*---------------------------------------------------------------------------------------------*
 * Usage + dispatch
 *---------------------------------------------------------------------------------------------*/

const USAGE = `usage: node scripts/upstream/upstream.mjs <command> [options]

commands:
  check    fetch upstream and report drift vs the recorded base. exit 0 = clean,
           1 = drift, 2 = drift touching protected paths, 3 = fetch error, 4 = config error
  status   human-readable dashboard (also updates scripts/upstream/.status.json)
  fetch    fetch + prune only
  report   write scripts/upstream/report/<timestamp>-upstream-report.md and print its path
  test     integration self-checks: fork diff allowlist, frappeStudio presence and
           integration seam, then scripts/upstream/selftest.mjs
  sync     full update workflow (clean tree -> branch -> merge -> test -> typecheck ->
           update base/refs -> single commit). NEVER pushes, NEVER force, NEVER
           auto-resolves conflicts. On conflicts: abort + write a conflict report.

options:
  --help   show this text
`;

function main() {
    const argv = process.argv.slice(2);
    const command = argv[0];
    if (!command || command === '--help' || command === '-h') {
        process.stdout.write(command ? USAGE : `no command given\n\n${USAGE}`);
        return command ? 0 : 2;
    }

    const cfg = readConfig();
    switch (command) {
        case 'check': return withExit(cmdCheck(cfg));
        case 'status': return withExit(cmdStatus(cfg));
        case 'fetch': return withExit(cmdFetch(cfg));
        case 'report': return withExit(cmdReport(cfg));
        case 'test': return withExit(cmdTest(cfg, argv.includes('--quiet')));
        case 'sync': return withExit(cmdSync(cfg));
        default:
            die(`unknown command '${command}'\n\n${USAGE}`, 2);
            return 2;
    }
}

function withExit(fn) {
    const code = fn;
    if (typeof code === 'number' && code !== 0) { process.exit(code); }
    return code;
}

try {
    process.exitCode = main() ?? 0;
} catch (err) {
    console.error(`error: ${err?.message ?? String(err)}`);
    process.exitCode = 1;
}
