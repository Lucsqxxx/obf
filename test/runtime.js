// ═══════════════════════════════════════════════════════════════
//  UmbraX — Unified Lua runtime for tests
//
//  Prefers the REAL luau binary (doubles, exactly what Roblox runs) and
//  falls back to fengari (Lua 5.3, integers) only when no binary is found.
//  This exists because the two engines DISAGREE on number semantics: a
//  product above 2^53 is exact in fengari's 64-bit integers but loses
//  precision in Luau's doubles. A fuzzer that only ran in fengari could
//  never catch that class of bug (it's the one that shipped broken output
//  to Roblox while every test stayed green). Routing the fuzzer through
//  this module makes real Luau the authoritative gate whenever it's
//  available, and keeps fengari as a portable smoke-test fallback.
//
//  Same signature as lua-runtime.js:  runLua(src) -> { ok, output, err }
//  Plus: ENGINE ('luau' | 'fengari') and LUAU_PATH for callers that want
//  to print which engine actually ran.
//
//  Force fengari (e.g. to reproduce a Lua-5.3-only observation) with
//  UMBRAX_FORCE_FENGARI=1.
// ═══════════════════════════════════════════════════════════════
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── locate a luau binary (same search order as luau-real.js) ─────
function findLuau() {
    if (process.env.UMBRAX_FORCE_FENGARI) return null;
    const exe = process.platform === 'win32' ? 'luau.exe' : 'luau';
    const candidates = [];
    if (process.env.LUAU_BIN) candidates.push(process.env.LUAU_BIN);
    candidates.push(exe);                                     // PATH lookup
    candidates.push(path.join(__dirname, '..', '.luau-cache', exe));
    for (const c of candidates) {
        try { execFileSync(c, ['--help'], { stdio: 'ignore' }); return c; }
        catch { /* try next */ }
    }
    return null;
}

const LUAU = findLuau();

// Executor globals real scripts rely on but the plain luau CLI lacks. Kept
// minimal and matched to luau-real.js so both harnesses see the same env.
// Luau ships bit32/loadstring natively, so (unlike fengari) no polyfill.
const LUAU_SHIM = `
local __genv = {}
getgenv = function() return __genv end
getrenv = function() return _G end
`;

let _tmpDir = null;
function tmpDir() {
    if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrax-rt-'));
    return _tmpDir;
}

function runViaLuau(src) {
    const file = path.join(tmpDir(), 'run.luau');
    fs.writeFileSync(file, LUAU_SHIM + '\n' + src, { encoding: 'utf8' }); // no BOM — luau rejects U+FEFF
    try {
        const out = execFileSync(LUAU, [file], { encoding: 'utf8' });
        return { ok: true, output: out.replace(/\r\n/g, '\n').replace(/\n$/, ''), err: null };
    } catch (e) {
        const stderr = (e.stderr || '').toString();
        return { ok: false, output: (e.stdout || '').toString().replace(/\r\n/g, '\n').replace(/\n$/, ''), err: stderr || e.message };
    }
}

// fengari fallback — the Lua 5.3 in-process runner with its bit32/loadstring polyfill.
const { runLua: runViaFengari } = require('./lua-runtime');

const ENGINE = LUAU ? 'luau' : 'fengari';

function runLua(src) {
    return LUAU ? runViaLuau(src) : runViaFengari(src);
}

module.exports = { runLua, ENGINE, LUAU_PATH: LUAU };
