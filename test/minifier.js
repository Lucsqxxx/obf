// ═══════════════════════════════════════════════════════════════
//  UmbraX — Minifier suite
//
//  The built-in .minify fallback shrinks Lua without changing meaning. Its
//  hard contracts mirror the beautifier's:
//    1. Parse-preserving — minified output is still valid Lua 5.3 (luaparse).
//    2. Token-preserving — the significant token sequence (code + literal
//       VALUES, ignoring comments/whitespace, and ignoring `;` the minifier
//       inserts to keep statement boundaries) is identical before and after.
//    3. Actually smaller — for inputs with removable whitespace/comments.
//    4. Number-safe — never lets a digit run into a following name/keyword
//       (`1print`), which real Luau rejects even when our lexer tolerates it.
//
//  Run:  node test/minifier.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const luaparse = require('luaparse');
const { minify } = require('../src/obfuscator/minifier');
const { tokenize } = require('../src/obfuscator/lexer');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; failures.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

// Significant tokens excluding comments AND bare `;` (the minifier may insert a
// semicolon where a newline previously separated statements — a legal no-op).
function sigTokens(src) {
    return tokenize(src)
        .filter(t => t.type !== 'comment' && !(t.type === 'punct' && t.value === ';'))
        .map(t => `${t.type}:${t.value}`);
}
function sameTokens(a, c) {
    const x = sigTokens(a), y = sigTokens(c);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
}
function parses(src) {
    try { luaparse.parse(src, { luaVersion: '5.3' }); return true; }
    catch { return false; }
}

console.log('minifier: parse-preserving + token-preserving + smaller');

const SAMPLES = {
    'plain print':       'print("hi")',
    'ugly spacing':      'local    x  =  1   print(  x )',
    'nested if':         'if a then if b then print(1) end end',
    'for loop':          'for i = 1, 10 do print(i) end',
    'while loop':        'while x do x = x - 1 end',
    'repeat until':      'repeat x = x + 1 until x > 5',
    'block function':    'function f(a, b) return a + b end',
    'inline lambda':     'local g = function(x) return x * 2 end',
    'anon in call':      'pcall(function() print(1) end)',
    'table literal':     'local t = { a = 1, b = 2, c = { 3, 4 } }',
    'method chain':      'game:GetService("Players"):GetPlayers()',
    'string w/ keyword': 'local s = "end if then"\nprint(s)',
    'long string':       'local s = [[ if x then end ]]\nprint(s)',
    'elseif chain':      'if a then print(1) elseif b then print(2) else print(3) end',
    'comments stripped': 'local x = 1 -- set x\nprint(x) --[[ trailing ]]',
    'multi-assign':      'local a, b, c = 1, 2, 3\nprint(a, b, c)',
    'number then name':  'local x = 1\nlocal print2 = 2\nprint(x + print2)',
    'concat op':         'local s = a .. b .. c',
    'hex + names':       'local m = 0xFF\nlocal n = m + 1\nprint(n)',
    'backtick interp':   'local n = 5\nprint(`val is {n}!`)',
    'ambiguous call':    'local a = f\n(g)()',
};

for (const [label, src] of Object.entries(SAMPLES)) {
    let out;
    try { out = minify(src); }
    catch (err) { ok(`${label}: no throw`, false, err.message); continue; }
    // Only assert parse-preservation when luaparse (Lua 5.3) can parse the
    // ORIGINAL. Luau-only syntax (backtick interpolation, etc.) is unparseable
    // by luaparse, so the parse check is meaningless there — skip it.
    if (parses(src)) ok(`${label}: parses`, parses(out), `minified no longer parses: ${JSON.stringify(out)}`);
    ok(`${label}: tokens preserved`, sameTokens(src, out), JSON.stringify(out));
    ok(`${label}: no larger`, out.length <= src.length);
}

// ── Idempotence: minifying twice == minifying once ───────────────
for (const [label, src] of Object.entries(SAMPLES)) {
    const once = minify(src);
    ok(`${label}: idempotent`, minify(once) === once);
}

// ── Number-safety spot-checks: a digit must never touch a name/keyword ──
{
    const out = minify('local x = 1\nprint(x)');
    ok('digit not fused to keyword', !/\d(print|local|end|do|then|return)/.test(out) && !/1print/.test(out), JSON.stringify(out));
}
{
    const out = minify('for i = 1, 10 do print(i) end');
    ok('digit not fused before do', !/10do/.test(out), JSON.stringify(out));
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
process.exit(fail ? 1 : 0);
