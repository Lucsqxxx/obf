// ═══════════════════════════════════════════════════════════════
//  UmbraX — Validator suite
//
//  The validator is the gate BEFORE obfuscation. Two failure modes it must
//  avoid, both of which shipped at some point:
//    1. Passing garbage — a bare `L`, `lol`, `x +`, `return return` are not
//       valid programs but the old heuristic-only checks waved them through,
//       so the bot happily "obfuscated the letter L".
//    2. Rejecting valid Luau — the old _checkCompoundAssignments flagged `+=`
//       (a real Luau operator) as an error, bouncing legitimate scripts.
//
//  The parse gate (luaparse over a Luau→5.3 down-conversion) fixes both. This
//  suite pins the behaviour with an INVALID battery (must be rejected) and a
//  VALID battery (must pass), covering Luau-specific surface syntax.
//
//  Run:  node test/validator.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const LuaSyntaxValidator = require('../src/obfuscator/validator');
const v = new LuaSyntaxValidator();

let pass = 0, fail = 0;
const failures = [];
function expect(label, src, wantValid) {
    const r = v.validate(src);
    const good = r.valid === wantValid;
    if (good) { pass++; console.log(`  ✓ ${label}`); }
    else {
        fail++;
        const why = wantValid
            ? `expected VALID but rejected: ${r.errors[0] || '(no error msg)'}`
            : `expected INVALID but passed`;
        failures.push(`${label} — ${why}`);
        console.log(`  ✗ ${label} — ${why}`);
    }
}

console.log('validator: rejects non-programs, accepts valid Luau');

// ── must be REJECTED (not real programs) ─────────────────────────
const INVALID = {
    'bare identifier L':      'L',
    'bare identifier lol':    'lol',
    'dangling operator':      'x +',
    'lone keyword local':     'local',
    'double return':          'return return',
    'unclosed call':          'print(',
    'unclosed if':            'if x then',
    'bare numbers':           '1 2 3',
    'leading equals':         '= 5',
    'unbalanced end':         'end',
    'assign no rhs':          'local x =',
    'garbage tokens':         '@#$ %^&',
};
for (const [label, src] of Object.entries(INVALID)) expect(label, src, false);

// ── must be ACCEPTED (valid Lua / Luau) ──────────────────────────
const VALID = {
    'hello':                  'print("hi")',
    'local + return':         'local x = 1\nreturn x',
    'numeric for':            'for i = 1, 3 do print(i) end',
    'typed local':            'local x: number = 5\nprint(x)',
    'compound add (+=)':      'local x = 1\nx += 41\nprint(x)',
    'compound concat (..=)':  'local s = "a"\ns ..= "b"\nprint(s)',
    'string interpolation':   'local n = 5\nprint(`value {n}`)',
    'continue in loop':       'for i=1,5 do if i==2 then continue end print(i) end',
    'type alias':             'type Point = {x: number, y: number}\nlocal p: Point = {x=1,y=2}\nprint(p.x)',
    'export type':            'export type Pub = number\nlocal n: Pub = 7\nprint(n)',
    'generic function':       'local function id<T>(x: T): T return x end\nprint(id(9))',
    'type assertion (::)':    'local x = 5 :: any\nprint(x)',
    'floor division':         'print(7 // 2)',
    'exploit globals':        'getgenv().flag = "on"\nprint(getgenv().flag)',
    'roblox api':             'local P = game:GetService("Players")\nprint(P)',
    'backtick + expr':        'local a,b = 2,3\nprint(`sum {a+b}`)',
};
for (const [label, src] of Object.entries(VALID)) expect(label, src, true);

console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
process.exit(fail ? 1 : 0);
