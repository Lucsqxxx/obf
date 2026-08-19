// ═══════════════════════════════════════════════════════════════
//  UmbraX — Fuzz suite
//
//  The fixed fixtures cover hand-picked shapes; this suite generates
//  RANDOM but always-valid Lua 5.3 programs and asserts the obfuscated
//  output still prints byte-identical results. It runs through the real
//  luau binary (doubles — what Roblox executes) when one is available and
//  falls back to fengari (Lua 5.3) otherwise; see test/runtime.js. It exercises
//  the transform pipeline (number encoding incl. the MBA forms, string
//  encryption incl. the string pool, junk incl. runtime opaque
//  predicates, renaming, control-flow flattening) against inputs the
//  author never wrote by hand — the cases that catch off-by-one edits.
//
//  Deterministic by default: a fixed PRNG seed makes failures
//  reproducible. Override with FUZZ_SEED / FUZZ_CASES env vars.
//
//  Run:  node test/fuzz.js
// ═══════════════════════════════════════════════════════════════
'use strict';

// Prefer the REAL luau binary (doubles — what Roblox runs); fall back to
// fengari (Lua 5.3) only when no binary is present. Running the fuzzer in
// fengari alone is what let a double-precision bug ship green, so real Luau
// is the authoritative gate here whenever it's available.
const { runLua, ENGINE, LUAU_PATH } = require('./runtime');
const Transformer = require('../src/obfuscator/transformer');
const rngmod = require('../src/obfuscator/rng');

// ── Reproducible PRNG (mulberry32) ───────────────────────────────
// We never use Math.random here — the program generator AND the transformer's
// own randomness (via rng.js, seeded per-transform below) are both pinned to
// FUZZ_SEED, so any failing case can always be replayed by re-running with the
// same FUZZ_SEED.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SEED = parseInt(process.env.FUZZ_SEED || '1337', 10);
const CASES = parseInt(process.env.FUZZ_CASES || '60', 10);
const rng = mulberry32(SEED);
const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (arr) => arr[ri(0, arr.length - 1)];

// ── Random program generator ─────────────────────────────────────
// Emits a self-contained chunk that ends by print()-ing a computed value,
// so runtime equivalence is observable. Every construct here is plain
// Lua 5.3 (runs in fengari) and avoids anything nondeterministic (no
// os.time/os.clock/pairs-order-dependent output). String literals include
// characters that stress the cipher and the splitter (quotes, tabs, spaces).
const WORDS = ['alpha', 'b e t a', 'ga\\tmma', 'de"lta', 'epsilon', 'zeta42', 'x', 'hello world'];

function genExpr(depth) {
    if (depth <= 0 || rng() < 0.3) return String(ri(0, 500000));
    const op = pick(['+', '-', '*']);
    const a = genExpr(depth - 1);
    const b = op === '-' ? String(ri(0, 1000)) : String(ri(1, 999));
    return `(${a}${op}${b})`;
}

function genProgram() {
    const lines = [];
    const nLocals = ri(1, 4);
    const localNames = [];
    for (let i = 0; i < nLocals; i++) {
        const name = `v${i}`;
        localNames.push(name);
        lines.push(`local ${name} = ${genExpr(ri(1, 3))}`);
    }
    // A loop that accumulates into one of the locals.
    const acc = pick(localNames);
    lines.push(`for _i = 1, ${ri(1, 20)} do ${acc} = ${acc} + _i end`);
    // A conditional that may add a constant.
    const cond = pick(localNames);
    lines.push(`if ${cond} % 2 == 0 then ${acc} = ${acc} + ${ri(1, 100)} else ${acc} = ${acc} + ${ri(1, 100)} end`);
    // A string built by concatenation, then printed with its length. Words may
    // contain `"` and `\` (to stress the cipher/splitter); escape them so the
    // GENERATED literal is valid Lua — the decoded value still carries them.
    const esc = (w) => w.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const parts = Array.from({ length: ri(1, 3) }, () => esc(pick(WORDS)));
    lines.push(`local s = "${parts.join('" .. "')}"`);
    lines.push(`print(${acc}, #s)`);
    return lines.join('\n');
}

// ── Layer combinations to fuzz (all must preserve output) ─────────
const BASE = { renameVariables: true, addJunkCode: true, encodeNumbers: true, minStringLength: 1, watermark: true };
const COMBOS = [
    {},
    { deepNumbers: true },
    { stringPool: true },
    { splitStrings: true, stringPool: true },
    { controlFlow: true },
    { splitStrings: true, controlFlow: true, deepNumbers: true, stringPool: true },
    // Numeric VM: integer literals compile to bytecode run by an emitted stack
    // machine. encodeNumbers off here so this exercises the VM path exclusively
    // (its emitted program byte-string must survive the string cipher intact).
    { encodeNumbers: false, virtualizeNumbers: true },
    // VM composed with the full stack — the program byte-string now also passes
    // through string splitting/pool encryption and control-flow flattening.
    { virtualizeNumbers: true, deepNumbers: true, splitStrings: true, stringPool: true, controlFlow: true },
];

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log(`fuzz: ${CASES} random programs × ${COMBOS.length} layer combos (seed=${SEED})`);
console.log(`  engine: ${ENGINE}${ENGINE === 'luau' ? ` (${LUAU_PATH})` : ' — fengari fallback; install luau for authoritative double-precision coverage'}`);

const t = new Transformer();
for (let c = 0; c < CASES; c++) {
    const prog = genProgram();
    const orig = runLua(prog);
    if (!orig.ok) {
        // A generator bug (invalid program) should fail loudly, not hide.
        ok(`case ${c} original`, false, 'generated program did not run: ' + orig.err + '\n----\n' + prog);
        continue;
    }
    for (let k = 0; k < COMBOS.length; k++) {
        const opts = COMBOS[k];
        const label = `case ${c} combo ${k}`;
        // Pin the TRANSFORMER's own randomness too, not just the program
        // generator. Without this the transform draws from Math.random, so a
        // failure here could never be replayed from FUZZ_SEED (the suite's
        // whole promise). Derive a distinct, stable sub-seed per (seed,case,combo)
        // so every transform is independently reproducible.
        const subSeed = (Math.imul(SEED ^ 0x9E3779B9, 2654435761) ^ Math.imul(c + 1, 40503) ^ (k * 0x85EBCA6B)) >>> 0;
        rngmod.seed(subSeed);
        let out;
        try { out = t.transform(prog, { ...BASE, ...opts }); }
        catch (e) { ok(label, false, 'transform threw ' + e.message + `  [subSeed=${subSeed}]` + '\n----\n' + prog); continue; }
        const got = runLua(out);
        if (!got.ok) { ok(label, false, 'obfuscated failed: ' + got.err + `  [subSeed=${subSeed}]` + '\n----\n' + prog + '\n----OBF----\n' + out); continue; }
        ok(label, got.output === orig.output,
            got.output === orig.output ? '' : `expected ${JSON.stringify(orig.output)} got ${JSON.stringify(got.output)}  [subSeed=${subSeed}]\n----\n${prog}\n----OBF----\n${out}`);
    }
}

rngmod.seed(null);   // restore Math.random; don't leak a global seed

console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log(`\nReplay with:  FUZZ_SEED=${SEED} node test/fuzz.js`); }
process.exit(fail ? 1 : 0);
