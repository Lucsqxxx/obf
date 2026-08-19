// ═══════════════════════════════════════════════════════════════
//  UmbraX — REAL Luau runtime suite
//
//  Every other runtime harness uses fengari, which is Lua 5.3 — NOT Luau.
//  That gap hid a fatal bug: the loader's outer LCG did a bare
//  `xk*1103515245`, which overflows 2^53 and loses precision in Luau's
//  DOUBLE-based numbers (Lua 5.3 uses 64-bit integers, so fengari computed
//  it exactly and every test passed while real Roblox output was garbage).
//
//  This suite runs the obfuscated output through the OFFICIAL luau binary
//  (github.com/luau-lang/luau releases) and compares printed output to the
//  original — the only test that reflects what Roblox actually does.
//
//  The luau binary is located via (in order):
//    1. $LUAU_BIN                    (explicit path to luau[.exe])
//    2. `luau` on PATH
//    3. .luau-cache/luau[.exe]       (repo-local, e.g. downloaded by CI)
//  If none is found the suite SKIPS (exit 0) with a hint — it never fails a
//  machine that simply doesn't have luau installed. To make it mandatory in
//  CI, set LUAU_BIN and the skip path won't be taken.
//
//  Run:  node test/luau-real.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Transformer = require('../src/obfuscator/transformer');
const { RUNNABLE } = require('./fixtures');

// ── locate a luau binary ─────────────────────────────────────────
function findLuau() {
    const exe = process.platform === 'win32' ? 'luau.exe' : 'luau';
    const candidates = [];
    if (process.env.LUAU_BIN) candidates.push(process.env.LUAU_BIN);
    candidates.push(exe); // PATH lookup
    candidates.push(path.join(__dirname, '..', '.luau-cache', exe));
    // luau has no --version; --help exits 0 and is a cheap "does it run" probe.
    for (const c of candidates) {
        try {
            execFileSync(c, ['--help'], { stdio: 'ignore' });
            return c;
        } catch { /* try next */ }
    }
    return null;
}

const LUAU = findLuau();
if (!LUAU) {
    console.log('real-luau: SKIPPED — no luau binary found.');
    console.log('  Install from https://github.com/luau-lang/luau/releases and either');
    console.log('  put it on PATH, set $LUAU_BIN, or drop it in .luau-cache/.');
    process.exit(0);
}

// Executor globals real scripts rely on but the plain luau CLI lacks. Kept
// minimal — just enough that fixtures using getgenv() run. `print` is native.
const SHIM = `
local __genv = {}
getgenv = function() return __genv end
getrenv = function() return _G end
`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrax-luau-'));
function runLuau(src) {
    const file = path.join(tmpDir, 'run.luau');
    // no BOM — luau rejects U+FEFF
    fs.writeFileSync(file, SHIM + '\n' + src, { encoding: 'utf8' });
    try {
        const out = execFileSync(LUAU, [file], { encoding: 'utf8' });
        return { ok: true, output: out.replace(/\r\n/g, '\n').replace(/\n$/, ''), err: null };
    } catch (e) {
        const stderr = (e.stderr || '').toString();
        return { ok: false, output: (e.stdout || '').toString(), err: stderr || e.message };
    }
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log(`real-luau: obfuscated output ≡ original in real Luau (${LUAU})`);

const t = new Transformer();
const OPTS = { renameVariables: true, addJunkCode: true, encodeNumbers: true, minStringLength: 1, watermark: true };
const VARIANTS = [
    { label: '', opts: {} },
    { label: ' +cff', opts: { controlFlow: true } },
    { label: ' +split', opts: { splitStrings: true } },
    { label: ' +deep', opts: { deepNumbers: true } },
    { label: ' +pool', opts: { stringPool: true } },
];

for (const [name, code] of Object.entries(RUNNABLE)) {
    const orig = runLuau(code);
    if (!orig.ok) { ok(`original ${name}`, false, 'original errored in luau: ' + orig.err); continue; }
    for (const { label, opts } of VARIANTS) {
        let out;
        try { out = t.transform(code, { ...OPTS, ...opts }); }
        catch (e) { ok(`${name}${label}`, false, 'transform threw ' + e.message); continue; }
        const got = runLuau(out);
        if (!got.ok) { ok(`${name}${label}`, false, 'obfuscated errored: ' + got.err.split('\n')[0]); continue; }
        ok(`${name}${label}`, got.output === orig.output,
            got.output === orig.output ? '' : `expected ${JSON.stringify(orig.output)} got ${JSON.stringify(got.output)}`);
    }
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
process.exit(fail ? 1 : 0);
