/*---------------------------------------------------------------------------------------------
 * frappe-studio: repository config sanity checker
 * Run with:  node scripts/upstream/repo-sanity.mjs [--strict]
 *
 * Zero-dependency check that the repo's fork-integration config is coherent:
 *   1. package.json parses and reports basic facts
 *   2. product.json parses
 *   3. scripts/upstream/config.json parses and has the required keys
 *   4. src/vs/workbench/contrib/frappeStudio exists with TypeScript sources
 *   5. src/vs/workbench/workbench.common.main.ts references frappeStudio
 *      (WARNING by default so a repo mid-integration doesn't go red; with
 *       --strict this check is fatal, used by CI once integration has landed)
 *
 * Never runs git, never mutates anything except nothing. Exits 1 on fatal failures.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonComments } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const strict = process.argv.includes('--strict');

let fatals = 0;
let warns = 0;

function ok(message) {
    console.log(`  ok: ${message}`);
}

function fail(message) {
    console.error(`  FAIL: ${message}`);
    fatals += 1;
}

function warn(message) {
    console.warn(`  warn: ${message}`);
    warns += 1;
}

function subsection(title) {
    console.log(`\n${title}`);
}

console.log('repo-sanity: checking frappe-studio integration configuration\n');

// 1. package.json ------------------------------------------------------------------------
subsection('package.json');
const packageJsonPath = path.join(ROOT, 'package.json');
let pkg;
if (!fs.existsSync(packageJsonPath)) {
    fail('package.json is missing');
} else {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    try {
        pkg = JSON.parse(stripJsonComments(raw));
        ok(`parses (name=${pkg?.name}, version=${pkg?.version}, packageManager=${pkg?.packageManager ?? '(none)'})`);
    } catch (err) {
        fail(`does not parse: ${err.message}`);
    }
}

// 2. product.json ------------------------------------------------------------------------
subsection('product.json');
const productJsonPath = path.join(ROOT, 'product.json');
if (!fs.existsSync(productJsonPath)) {
    fail('product.json is missing');
} else {
    try {
        const product = JSON.parse(stripJsonComments(fs.readFileSync(productJsonPath, 'utf8')));
        ok(`parses (quality=${product.quality ?? '(none)'})`);
    } catch (err) {
        fail(`does not parse: ${err.message}`);
    }
}

// 3. scripts/upstream/config.json ---------------------------------------------------------
subsection('scripts/upstream/config.json');
const configJsonPath = path.join(ROOT, 'scripts', 'upstream', 'config.json');
const requiredConfigKeys = [
    'upstreamRemote', 'upstreamRef', 'forkRemote', 'mainBranch', 'upstreamBaseCommit',
    'upstreamBaseTagRef', 'syncBranchPrefix', 'protectedPaths',
    'mechanicallyResolvableConflictKinds', 'maxCommitsBehindBeforeWarning',
];
if (!fs.existsSync(configJsonPath)) {
    fail('config.json is missing');
} else {
    try {
        const cfg = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
        const missing = requiredConfigKeys.filter((key) => !(key in cfg));
        if (missing.length > 0) {
            fail(`missing required keys: ${missing.join(', ')}`);
        } else {
            const validSha = /^[0-9a-f]{40}$/.test(cfg.upstreamBaseCommit);
            ok(`parses; upstreamBaseCommit ${validSha ? 'is a full SHA' : 'is NOT a full 40-char SHA'}${validSha ? '' : ' (FAIL expected below)'}`);
            if (!validSha) {
                fail(`upstreamBaseCommit is not a full 40-char sha: ${cfg.upstreamBaseCommit}`);
            }
            if (!Array.isArray(cfg.protectedPaths) || cfg.protectedPaths.length === 0) {
                fail('protectedPaths must be a non-empty array');
            }
        }
    } catch (err) {
        fail(`does not parse: ${err.message}`);
    }
}

// 4. frappeStudio contrib directory --------------------------------------------------------
subsection('src/vs/workbench/contrib/frappeStudio');
const contribDir = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'frappeStudio');
if (!fs.existsSync(contribDir) || !fs.statSync(contribDir).isDirectory()) {
    fail('contrib directory is missing');
} else {
    let tsFiles = [];
    try {
        tsFiles = fs.readdirSync(contribDir, { recursive: true }).filter((f) => String(f).endsWith('.ts'));
    } catch (err) {
        fail(`cannot list the directory: ${err.message}`);
    }
    if (tsFiles.length > 0) {
        ok(`present with ${tsFiles.length} TypeScript file(s) (e.g. ${tsFiles[0]})`);
    } else if (fs.readdirSync(contribDir).length === 0) {
        fail('contrib directory exists but is empty');
    } else {
        warn('contrib directory exists but contains no TypeScript files');
    }
}

// 5. integration seam in workbench.common.main.ts ------------------------------------------
subsection('integration seam (src/vs/workbench/workbench.common.main.ts)');
const mainFilePath = path.join(ROOT, 'src', 'vs', 'workbench', 'workbench.common.main.ts');
if (!fs.existsSync(mainFilePath)) {
    fail('workbench.common.main.ts is missing');
} else {
    const text = fs.readFileSync(mainFilePath, 'utf8');
    if (/frappeStudio/i.test(text)) {
        ok('references frappeStudio');
    } else if (strict) {
        fail('workbench.common.main.ts does not reference frappeStudio (strict mode)');
    } else {
        warn('workbench.common.main.ts does not reference frappeStudio yet — expected while ' +
            'the fork integration is in flight; CI (strict mode) will gate on this once it lands');
    }
}

console.log('');
console.log(`repo-sanity summary: ${fatals} fatal, ${warns} warning(s)${strict ? ' (strict mode)' : ''}\n`);
process.exit(fatals > 0 ? 1 : 0);
