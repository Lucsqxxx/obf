// ═══════════════════════════════════════════════════════════════
//  UmbraX — Test Suite
//
//  Four layers of assurance:
//    1. unit      — engine + loader round-trip self-tests and lexer
//    2. parse     — every obfuscated output is valid Lua 5.3 (outer)
//    3. runtime   — obfuscated script EXECUTES in a real Lua VM (fengari)
//                   and prints byte-identical output to the original
//    4. opt-in    — the same runtime check under split / CFF / both
//
//  Layer 3 is the one that catches a silent cipher/loader break that
//  syntax checks cannot.  Run with:  npm test
//
//  The script battery lives in test/fixtures.js (shared by all harnesses).
// ═══════════════════════════════════════════════════════════════

'use strict';

const luaparse = require('luaparse');
const { runLua } = require('./lua-runtime');
const { RUNNABLE, ALL } = require('./fixtures');

const Engine = require('../src/obfuscator/engine');
const Transformer = require('../src/obfuscator/transformer');
const loader = require('../src/obfuscator/loader');
const { tokenize, stringValue } = require('../src/obfuscator/lexer');
const antitamper = require('../src/obfuscator/antitamper');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── Layer 1: unit ────────────────────────────────────────────────
section('unit: engine / loader / lexer');
{
    const e = new Engine();
    // engine self-test already ran at require; re-assert a few round-trips.
    for (const s of ['', 'hello', 'game:GetService("X")', '🔒 emoji ✓', 'x'.repeat(300)]) {
        const r = e.verifyRoundTrip(s, 123456789);
        ok(`engine round-trip ${JSON.stringify(s.slice(0, 14))}`, r.ok, r.ok ? '' : `got ${JSON.stringify(r.recovered.slice(0, 20))}`);
    }
    // loader whole-script layer round-trips (JS twin of the emitted Lua decoder).
    for (const s of ['print("hi")', 'local x=1\nreturn x*2', '🔒 unicode ✓ in script', 'a'.repeat(5000)]) {
        const r = loader.verifyRoundTrip(s);
        ok(`loader round-trip ${JSON.stringify(s.slice(0, 14))}`, r.ok, r.ok ? '' : `got ${JSON.stringify(r.recovered.slice(0, 20))}`);
    }
    // lexer basics
    const toks = tokenize('local s = "hi" -- c');
    ok('lexer tokenizes', toks.length === 5 && toks[3].type === 'string');
    ok('lexer stringValue decodes', stringValue(tokenize('"a\\tb"')[0]) === 'a\tb');
    // anti-tamper count is a positive integer
    ok('antitamper.checkCount > 0', Number.isInteger(antitamper.checkCount()) && antitamper.checkCount() > 0, `=${antitamper.checkCount()}`);
}

const FULL_OPTS = { renameVariables: true, addJunkCode: true, encodeNumbers: true, minStringLength: 1, watermark: true };

// ── Layer 2: parse (ALL fixtures — Roblox/Luau included) ─────────
section('parse: outer loader is valid Lua 5.3');
{
    const t = new Transformer();
    for (const [name, code] of Object.entries(ALL)) {
        let out, threw = null;
        try { out = t.transform(code, FULL_OPTS); } catch (e) { threw = e.message; }
        if (threw) { ok(`parse ${name}`, false, 'threw ' + threw); continue; }
        let parseErr = null;
        try { luaparse.parse(out, { luaVersion: '5.3' }); } catch (e) { parseErr = e.message; }
        ok(`parse ${name}`, !parseErr, parseErr);
    }
}

// ── Layer 3: runtime equivalence (RUNNABLE fixtures) ─────────────
section('runtime: obfuscated output ≡ original (fengari Lua VM)');
{
    const t = new Transformer();
    for (const [name, code] of Object.entries(RUNNABLE)) {
        const orig = runLua(code);
        if (!orig.ok) { ok(`runtime ${name}`, false, 'ORIGINAL failed: ' + orig.err); continue; }
        let out;
        try { out = t.transform(code, FULL_OPTS); }
        catch (e) { ok(`runtime ${name}`, false, 'transform threw ' + e.message); continue; }
        const got = runLua(out);
        if (!got.ok) { ok(`runtime ${name}`, false, 'OBFUSCATED failed: ' + got.err); continue; }
        ok(`runtime ${name}`, got.output === orig.output, got.output === orig.output ? '' : `expected ${JSON.stringify(orig.output)} got ${JSON.stringify(got.output)}`);
    }
}

// ── Layer 4: opt-in layers (string splitting, control flow) ──────
section('runtime: opt-in layers ≡ original (split / CFF / both)');
{
    const t = new Transformer();
    const variants = [
        { label: 'split', opts: { splitStrings: true } },
        { label: 'cff', opts: { controlFlow: true } },
        { label: 'both', opts: { splitStrings: true, controlFlow: true } },
        { label: 'pool', opts: { stringPool: true } },
        { label: 'pool+split', opts: { stringPool: true, splitStrings: true } },
    ];
    for (const { label, opts } of variants) {
        for (const [name, code] of Object.entries(RUNNABLE)) {
            const orig = runLua(code);
            if (!orig.ok) continue; // already covered above
            const full = Object.assign({}, FULL_OPTS, opts);
            let out;
            try { out = t.transform(code, full); }
            catch (e) { ok(`${label} ${name}`, false, 'transform threw ' + e.message); continue; }
            const got = runLua(out);
            ok(`${label} ${name}`, got.ok && got.output === orig.output,
                got.ok ? (got.output === orig.output ? '' : `expected ${JSON.stringify(orig.output)} got ${JSON.stringify(got.output)}`) : 'run failed: ' + got.err);
        }
    }
}

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
process.exit(fail ? 1 : 0);
