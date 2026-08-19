// ═══════════════════════════════════════════════════════════════
//  UmbraX — Numeric VM tests
//
//  Two gates:
//    1. JS-twin agreement  — evalAST == compile+interpret (also asserted at
//       module load, re-checked here across a wide value spread + both depths).
//    2. Emitted-Lua end-to-end — build the real interpreter source, emit VM
//       calls, and run them through the REAL luau binary (doubles — what Roblox
//       executes; fengari fallback otherwise). This is the check that catches a
//       JS↔Lua divergence the twin alone can't see.
//
//  Run:  node test/vm.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const vm = require('../src/obfuscator/vm');
const { runLua, ENGINE, LUAU_PATH } = require('./runtime');
const rngmod = require('../src/obfuscator/rng');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
    if (cond) pass++;
    else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log(`vm: engine ${ENGINE}${ENGINE === 'luau' ? ` (${LUAU_PATH})` : ' — fengari fallback; install luau for authoritative coverage'}`);

// ── 1. JS-twin agreement across a wide spread ────────────────────
rngmod.seed(0x5EED);
const ri = (lo, hi) => rngmod.randInt(lo, hi);
const fixed = [0, 1, 2, 3, 9, 10, 16, 100, 255, 256, 1023, 65535, 65536,
    1000000, 0x3FFFFFFF, 0x7FFFFFFE, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF,
    2147483648, 4503599627370495];
for (const depth of [1, 2, 3]) {
    for (let iter = 0; iter < 25; iter++) {
        const op = vm.makeOpcodes(ri);
        for (const v of fixed) {
            const ast = vm.buildNumberAST(v, depth, ri);
            const ev = vm.evalAST(ast);
            const prog = vm.compileAST(ast, op);
            const got = vm.interpret(prog.bytes, prog.consts, op);
            ok(`twin v=${v} d=${depth}`, ev === v && got === v, `eval=${ev} interp=${got}`);
        }
    }
}

// ── 2. Emitted-Lua end-to-end ────────────────────────────────────
// Build ONE interpreter, emit N calls that print their results, and run the
// whole thing through the Lua runtime. Compare each printed line to the value.
function luaEndToEnd(values, depth) {
    const rand = () => rngmod.rname(2, 8);
    const op = vm.makeOpcodes(ri);
    const names = vm.makeNames(rand);
    // simple deterministic shuffle from the seeded rng
    const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = ri(0, i); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

    const stub = vm.emitVM(names, op, shuffle);
    const lines = [stub];
    const expected = [];
    for (const v of values) {
        const call = vm.renderNumber(v, names, op, ri, depth);
        if (call === null) { // overflow/fallback: skip but note
            expected.push(null);
            lines.push(`print("SKIP")`);
        } else {
            expected.push(v);
            // string.format %d needs an integer; values ≤ 2^53 are integer-valued.
            lines.push(`print(string.format("%.0f", ${call}))`);
        }
    }
    const src = lines.join('\n');
    const res = runLua(src);
    if (!res.ok) return { ok: false, err: res.err, src };
    const outLines = res.output.split('\n');
    return { ok: true, outLines, expected, src };
}

rngmod.seed(0x1234);
for (const depth of [1, 2]) {
    const values = [0, 1, 2, 7, 9, 10, 42, 255, 256, 4095, 65535, 123456,
        1000000, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, 4503599627370495];
    const r = luaEndToEnd(values, depth);
    if (!r.ok) {
        ok(`lua e2e depth=${depth}`, false, 'runtime error: ' + r.err + '\n----\n' + r.src);
    } else {
        r.expected.forEach((exp, i) => {
            if (exp === null) return; // skipped (fallback path)
            const got = r.outLines[i];
            ok(`lua v=${exp} d=${depth}`, got === String(exp), `got ${JSON.stringify(got)}`);
        });
    }
}

// ── 3. Random large-value sweep through real Lua ─────────────────
rngmod.seed(0xABCDE);
{
    const values = [];
    for (let k = 0; k < 40; k++) {
        values.push(ri(0, 1) ? ri(0, vm.NUM_MID_MAX) : ri(vm.NUM_MID_MAX + 1, 4503599627370495));
    }
    const r = luaEndToEnd(values, 1);
    if (!r.ok) ok('lua random sweep', false, 'runtime error: ' + r.err + '\n----\n' + r.src);
    else r.expected.forEach((exp, i) => {
        if (exp === null) return;
        ok(`lua rand v=${exp}`, r.outLines[i] === String(exp), `got ${JSON.stringify(r.outLines[i])}`);
    });
}

rngmod.seed(null);
console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
