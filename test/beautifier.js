// ═══════════════════════════════════════════════════════════════
//  UmbraX — Beautifier suite
//
//  The .beautify command reformats Lua purely for readability, so its ONE
//  hard contract is: it must never change meaning. Two properties pin that:
//    1. Parse-preserving — beautified output is still valid Lua 5.3
//       (luaparse), so formatting never produces a broken program.
//    2. Token-preserving — the sequence of significant tokens (code + literal
//       VALUES, ignoring whitespace/comments/trivia) is identical before and
//       after. This catches a formatter that drops, duplicates, merges, or
//       reaches into a string literal.
//  A handful of indentation spot-checks guard the depth heuristics (the
//  block-vs-inline `function` disambiguation in particular).
//
//  Run:  node test/beautifier.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const luaparse = require('luaparse');
const LuaBeautifier = require('../src/obfuscator/beautifier');
const { tokenize } = require('../src/obfuscator/lexer');

const b = new LuaBeautifier();

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; failures.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

// Significant tokens = everything except comments (beautify may normalize
// comment spacing) — compared as [type,value] so a literal's content is checked.
function sigTokens(src) {
    return tokenize(src)
        .filter(t => t.type !== 'comment')
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

console.log('beautifier: parse-preserving + token-preserving');

const SAMPLES = {
    'plain print':      'print("hi")',
    'ugly spacing':     'local    x=1   print(  x )',
    'nested if':        'if a then if b then print(1) end end',
    'for loop':         'for i=1,10 do print(i) end',
    'while loop':       'while x do x=x-1 end',
    'repeat until':     'repeat x=x+1 until x>5',
    'block function':   'function f(a,b) return a+b end',
    'inline lambda':    'local g=function(x) return x*2 end',
    'anon in call':     'pcall(function() print(1) end)',
    'table literal':    'local t={a=1,b=2,c={3,4}}',
    'method chain':     'game:GetService("Players"):GetPlayers()',
    'string w/ keyword':'local s="end if then"\nprint(s)',
    'long string':      'local s=[[ if x then end ]]\nprint(s)',
    'elseif chain':     'if a then print(1) elseif b then print(2) else print(3) end',
    'already pretty':   'local x = 1\nif x then\n    print(x)\nend',
    'unicode literal':  'print("🔒 secure ✓")',
    'nested tables':    'local t={x={y={z=1}}}',
    'multi-assign':     'local a,b,c=1,2,3\nprint(a,b,c)',
};

for (const [label, src] of Object.entries(SAMPLES)) {
    let out;
    try { out = b.beautify(src); }
    catch (err) { ok(`${label}: no throw`, false, err.message); continue; }
    ok(`${label}: parses`, parses(out), parses(src) ? 'beautified output no longer parses' : '(original also unparseable — skip)');
    ok(`${label}: tokens preserved`, sameTokens(src, out));
}

// ── Idempotence: beautifying twice == beautifying once ───────────
for (const [label, src] of Object.entries(SAMPLES)) {
    const once = b.beautify(src);
    const twice = b.beautify(once);
    ok(`${label}: idempotent`, once === twice);
}

// ── Indentation spot-checks (depth heuristics) ───────────────────
// The beautifier re-indents existing lines; it does not insert line breaks,
// so these inputs are already multi-line to exercise the depth tracking.
{
    const out = b.beautify('if a then\nprint(1)\nend');
    ok('if-body indented one level', /\n {4}print\(1\)/.test(out), JSON.stringify(out));
}
{
    const out = b.beautify('function f()\nreturn 1\nend');
    ok('block function body indented', /\n {4}return 1/.test(out), JSON.stringify(out));
}
{
    // An inline lambda that fits on one line should NOT force block indentation
    // of following statements.
    const out = b.beautify('local g = function(x) return x end\nprint(g)');
    ok('inline lambda: print not over-indented', /\nprint\(g\)/.test(out), JSON.stringify(out));
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
process.exit(fail ? 1 : 0);
