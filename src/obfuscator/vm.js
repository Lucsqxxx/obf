// ═══════════════════════════════════════════════════════════════
//  UmbraX — Numeric Bytecode Virtualizer (VM)
//
//  Illunox-style virtualization, scoped to INTEGER LITERALS. Each eligible
//  integer is compiled to bytecode for a tiny stack machine, and the literal
//  is replaced by a call `VM("<program>",{<consts>})`. One interpreter is
//  emitted per build; every number routes through it. The original constant
//  never appears in the output — it only materialises when the VM runs.
//
//  ONE spec drives three things that MUST agree, so they live in this file:
//    • compileAST  — JS: AST → bytecode + constant pool
//    • interpret   — JS twin of the emitted Lua VM (used by the self-test)
//    • emitVM      — the Lua interpreter source (the runtime twin)
//  A load-time self-test (bottom) compiles+interprets many values and asserts
//  the VM reproduces each one, so the twins can never silently drift.
//
//  DOUBLE-SAFETY (the invariant that ships correct Luau):
//    The AST builder reuses the EXACT tiers/bounds of transformer's
//    _encodeOneNumber — additive/subtractive/multiplicative splits kept
//    ≤ 2^53, and bit32 (xor/and/or) forms only for values ≤ 0x7FFFFFFF where
//    JS `^`/`&`/`|` (signed-32) and Lua bit32 (unsigned-32) agree. So the VM
//    computes in Luau doubles with no precision loss and no signedness split.
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

// Upper bound for the bit32/XOR forms — identical to transformer.NUM_MID_MAX.
// Above this, JS `^` (signed) and Lua bit32 (unsigned) diverge, so only
// add/multiply splits are used (every product kept ≤ 2^53 for exact doubles).
const NUM_MID_MAX = 0x7FFFFFFF;

// Logical opcodes → the AST node tag they consume. The BYTE each maps to is
// assigned per-build (makeOpcodes), so two builds never share an instruction
// set — a static reader can't assume "byte 3 == ADD".
const OP_OF_TAG = { '+': 'ADD', '-': 'SUB', '*': 'MUL', xor: 'XOR', and: 'AND', or: 'OR' };
const OPCODES = ['PUSH', 'ADD', 'SUB', 'MUL', 'XOR', 'AND', 'OR'];

// ── Per-build polymorphic opcode assignment ──────────────────────
// Give each logical opcode a distinct byte in [1,127] (0 reserved as "unused"
// so a stray zero byte can't be mistaken for a real op). Drawn from the passed
// randInt so seeded builds are reproducible.
//
// Why cap at 127 (not 255): the emitted VM program is a Lua string literal that
// the transformer's string-encryption pass may re-encrypt. That cipher operates
// on UTF-8 bytes, so any program byte ≥ 128 would expand to a 2-byte UTF-8
// sequence and corrupt the bytecode on decrypt. Keeping every program byte
// (opcodes AND constant-pool indices) in the ASCII range makes the program
// round-trip through the cipher byte-for-byte. 127 distinct values for 7
// opcodes is still ample polymorphism.
function makeOpcodes(randInt) {
    const pool = [];
    for (let b = 1; b <= 127; b++) pool.push(b);
    // Fisher-Yates over the byte pool, take the first OPCODES.length.
    for (let i = pool.length - 1; i > 0; i--) {
        const j = randInt(0, i);
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const op = {};
    OPCODES.forEach((name, i) => { op[name] = pool[i]; });
    return op;
}

// ── AST builder — twin of transformer._encodeOneNumber's tiers ───
// Returns a tree of {t:'k',v} | {t:<op>,a,b}. Same random choices, same
// operand bounds, so the value distribution and double-safety match exactly.
function buildNumberAST(val, depth, randInt) {
    const K = (n) => ({ t: 'k', v: n });
    const operand = (n) => (depth > 1 && Number.isSafeInteger(n) && n >= 0)
        ? buildNumberAST(n, depth - 1, randInt)
        : K(n);

    // Tiny tier [0,9] — subtraction offset works for any val≥0; additive for ≥2.
    if (val <= 9) {
        if (val >= 2 && randInt(0, 1) === 0) {
            const a = randInt(1, val - 1);
            return { t: '+', a: operand(a), b: operand(val - a) };
        }
        const r = randInt(1, 0xFFFF);
        return { t: '-', a: operand(val + r), b: operand(r) };
    }

    // Large tier (>0x7FFFFFFF) — add/multiply splits only (bit32 would diverge).
    if (val > NUM_MID_MAX) {
        switch (randInt(0, 2)) {
            case 0: {
                const Kf = [10000, 100000, 1000000][randInt(0, 2)];
                const base = Math.floor(val / Kf);
                return { t: '+', a: { t: '*', a: operand(base), b: K(Kf) }, b: operand(val - base * Kf) };
            }
            case 1: {
                const a = randInt(1, 0x3FFFFFFF);
                return { t: '+', a: operand(a), b: operand(val - a) };
            }
            default: {
                const Kf = randInt(2, 9);
                const base = Math.floor(val / Kf);
                return { t: '+', a: { t: '*', a: operand(base), b: K(Kf) }, b: operand(val - base * Kf) };
            }
        }
    }

    // Mid tier [10, 0x7FFFFFFF] — full arsenal incl. MBA identities.
    switch (randInt(0, 6)) {
        case 0: { const k = randInt(1, 0xFFFF); return { t: 'xor', a: operand(val ^ k), b: K(k) }; }
        case 1: { const a = randInt(1, val - 1); return { t: '+', a: operand(a), b: operand(val - a) }; }
        case 2: {
            const d = [2, 3, 4, 5, 8][randInt(0, 4)];
            const base = Math.floor(val / d);
            return { t: '+', a: { t: '*', a: operand(base), b: K(d) }, b: operand(val - base * d) };
        }
        case 3: {
            const k1 = randInt(1, 0xFFFF), k2 = randInt(1, 0xFFFF);
            return { t: 'xor', a: { t: 'xor', a: operand(val ^ k1 ^ k2), b: K(k1) }, b: K(k2) };
        }
        // MBA: (a XOR b) + 2*(a AND b) == a + b  (exact for non-negative ints).
        case 4: {
            const a = randInt(1, val - 1), b = val - a;
            return { t: '+', a: { t: 'xor', a: operand(a), b: operand(b) }, b: { t: '*', a: K(2), b: { t: 'and', a: operand(a), b: operand(b) } } };
        }
        // MBA: (a OR b) + (a AND b) == a + b.
        case 5: {
            const a = randInt(1, val - 1), b = val - a;
            return { t: '+', a: { t: 'or', a: operand(a), b: operand(b) }, b: { t: 'and', a: operand(a), b: operand(b) } };
        }
        default: { const a = randInt(1, val - 1); return { t: '+', a: operand(a), b: operand(val - a) }; }
    }
}

// ── JS evaluator — the value an AST denotes ──────────────────────
// bit ops force `>>> 0`: operands are ≤0x7FFFFFFF so bit 31 is clear, the
// result is non-negative, and this matches Lua bit32's unsigned semantics.
function evalAST(ast) {
    if (ast.t === 'k') return ast.v;
    const a = evalAST(ast.a), b = evalAST(ast.b);
    switch (ast.t) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case 'xor': return (a ^ b) >>> 0;
        case 'and': return (a & b) >>> 0;
        case 'or': return (a | b) >>> 0;
        default: throw new Error('vm: bad AST tag ' + ast.t);
    }
}

// ── Compile AST → { bytes, consts } ──────────────────────────────
// Post-order: operands first, then the operator opcode — so the stack machine
// finds both operands on the stack when it hits the op. Constants are deduped
// by value (pure), which keeps the pool small and indices in-byte-range.
// Throws (→ caller bails to a plain literal) if the pool exceeds 256 entries or
// the program exceeds 65535 bytes; per-number programs never approach either.
function compileAST(ast, op) {
    const bytes = [];
    const consts = [];
    const byValue = new Map();
    const kIndex = (v) => {
        let idx = byValue.get(v);
        if (idx === undefined) { idx = consts.length; consts.push(v); byValue.set(v, idx); }
        return idx;
    };
    (function emit(node) {
        if (node.t === 'k') {
            const idx = kIndex(node.v);
            // Index is emitted as a raw program byte and must survive the UTF-8
            // string cipher, so it stays ASCII (≤127) — same reason as the opcode
            // cap in makeOpcodes. Overflow → caller falls back to a plain literal.
            if (idx > 127) throw new Error('vm: constant pool overflow');
            bytes.push(op.PUSH, idx);
            return;
        }
        emit(node.a); emit(node.b);
        bytes.push(op[OP_OF_TAG[node.t]]);
    })(ast);
    if (bytes.length > 0xFFFF) throw new Error('vm: program too long');
    return { bytes, consts };
}

// ── JS twin of the emitted Lua interpreter ───────────────────────
// Stack machine; JS is 0-based (Lua is 1-based) but the algorithm is identical.
// Used only by the self-test and by renderNumber's build-time verification.
function interpret(bytes, consts, op) {
    const S = [];
    let T = 0, I = 0;
    const L = bytes.length;
    while (I < L) {
        const O = bytes[I++];
        if (O === op.PUSH) { S[T++] = consts[bytes[I++]]; }
        else if (O === op.ADD) { S[T - 2] = S[T - 2] + S[T - 1]; T--; }
        else if (O === op.SUB) { S[T - 2] = S[T - 2] - S[T - 1]; T--; }
        else if (O === op.MUL) { S[T - 2] = S[T - 2] * S[T - 1]; T--; }
        else if (O === op.XOR) { S[T - 2] = (S[T - 2] ^ S[T - 1]) >>> 0; T--; }
        else if (O === op.AND) { S[T - 2] = (S[T - 2] & S[T - 1]) >>> 0; T--; }
        else if (O === op.OR) { S[T - 2] = (S[T - 2] | S[T - 1]) >>> 0; T--; }
        else throw new Error('vm: unknown opcode ' + O);
    }
    return S[0];
}

// ── Lua serialisation ────────────────────────────────────────────
function toLuaByteString(bytes) {
    const parts = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) parts[i] = '\\' + bytes[i].toString().padStart(3, '0');
    return parts.join('');
}

// Polymorphic name set for the VM stub. Separate from the decrypt stub's names
// so the two layers stay decoupled (VM works with encryption on or off).
function makeNames(rand) {
    return { vm: rand(), bx: rand(), bnd: rand(), bor: rand(), sb: rand() };
}

// ── Emit the Lua interpreter (twin of `interpret`) ───────────────
// One `do ... end` block defining VM(P,C): P is a byte string (read via
// string.byte), C the constant pool table. The dispatch arms are emitted in a
// SHUFFLED order and keyed by the per-build opcode bytes, so neither the branch
// order nor the byte values leak the instruction set. Uses a bare `bit32`
// global (like emitDecryptStub) so the loader's 5.4 shim is picked up.
function emitVM(n, op, shuffle) {
    // Local stack-machine registers (locals inside VM — names are cosmetic).
    // P=program C=consts S=stack T=top I=ip L=len O=opcode
    const arms = [
        { b: op.PUSH, body: `${'T'}=T+1 S[T]=C[${n.sb}(P,I)+1] I=I+1` },
        { b: op.ADD, body: `S[T-1]=S[T-1]+S[T] T=T-1` },
        { b: op.SUB, body: `S[T-1]=S[T-1]-S[T] T=T-1` },
        { b: op.MUL, body: `S[T-1]=S[T-1]*S[T] T=T-1` },
        { b: op.XOR, body: `S[T-1]=${n.bx}(S[T-1],S[T]) T=T-1` },
        { b: op.AND, body: `S[T-1]=${n.bnd}(S[T-1],S[T]) T=T-1` },
        { b: op.OR, body: `S[T-1]=${n.bor}(S[T-1],S[T]) T=T-1` },
    ];
    shuffle(arms);
    let dispatch = '';
    arms.forEach((a, i) => {
        dispatch += `${i === 0 ? 'if' : 'elseif'} O==${a.b} then ${a.body} `;
    });
    dispatch += 'end';

    return [
        `do `,
        `local ${n.bx},${n.bnd},${n.bor}=bit32.bxor,bit32.band,bit32.bor;`,
        `local ${n.sb}=string.byte;`,
        `function ${n.vm}(P,C)`,
        `local S={} local T=0 local I=1 local L=#P `,
        `while I<=L do `,
        `local O=${n.sb}(P,I) I=I+1 `,
        dispatch,
        ` end `,
        `return S[1] `,
        `end `,
        `end;`,
    ].join('');
}

// ── Build-time render of ONE integer → a VM call (or null) ───────
// Builds the AST, compiles it, and VERIFIES (JS twin) that the program
// reproduces `val` before emitting — so a mis-built program can never ship.
// Returns the Lua call string, or null to signal the caller should fall back
// to a plain literal (constant-pool/program overflow, or a failed check).
function renderNumber(val, names, op, randInt, depth = 1) {
    if (!Number.isSafeInteger(val) || val < 0) return null;
    let prog;
    try {
        const ast = buildNumberAST(val, depth, randInt);
        if (evalAST(ast) !== val) return null;                 // AST sanity
        prog = compileAST(ast, op);
        if (interpret(prog.bytes, prog.consts, op) !== val) return null; // twin check
    } catch { return null; }
    const consts = prog.consts.map(v => String(v)).join(',');
    return `${names.vm}("${toLuaByteString(prog.bytes)}",{${consts}})`;
}

// ── Load-time self-test: VM must reproduce every value ───────────
// Guards the JS compiler ↔ JS twin agreement (and, by construction, the Lua
// emitter which shares the exact algorithm). The emitted-Lua end-to-end path is
// separately exercised by test/vm.js against a real Luau binary.
(function selfTest() {
    // Deterministic local RNG so the self-test is stable across runs.
    let a = 0xC0FFEE >>> 0;
    const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const ri = (lo, hi) => Math.floor(rnd() * (hi - lo + 1)) + lo;

    const samples = [0, 1, 2, 5, 9, 10, 42, 255, 256, 65535, 1000000,
        0x7FFFFFFE, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, 4503599627370495 /* 2^52-1 */];
    for (const depth of [1, 2]) {
        for (let iter = 0; iter < 40; iter++) {
            const op = makeOpcodes(ri);
            for (const v of samples) {
                const ast = buildNumberAST(v, depth, ri);
                if (evalAST(ast) !== v) throw new Error(`[vm] eval mismatch v=${v} depth=${depth}`);
                const { bytes, consts } = compileAST(ast, op);
                if (interpret(bytes, consts, op) !== v) throw new Error(`[vm] interpret mismatch v=${v} depth=${depth}`);
            }
            // a spread of random mid/large values too
            for (let k = 0; k < 20; k++) {
                const v = ri(0, 1) ? ri(10, NUM_MID_MAX) : ri(NUM_MID_MAX + 1, 4503599627370495);
                const ast = buildNumberAST(v, depth, ri);
                if (evalAST(ast) !== v) throw new Error(`[vm] eval mismatch (rand) v=${v}`);
                const { bytes, consts } = compileAST(ast, op);
                if (interpret(bytes, consts, op) !== v) throw new Error(`[vm] interpret mismatch (rand) v=${v}`);
            }
        }
    }
})();

module.exports = {
    NUM_MID_MAX,
    OPCODES,
    makeOpcodes,
    buildNumberAST,
    evalAST,
    compileAST,
    interpret,
    toLuaByteString,
    makeNames,
    emitVM,
    renderNumber,
};
