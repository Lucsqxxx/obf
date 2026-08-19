// ═══════════════════════════════════════════════════════════════
//  UmbraX — Obfuscation Transformer
//
//  Token-based. Every pass tokenizes via lexer.js and splices by exact
//  token offsets (right-to-left, so earlier offsets stay valid). Nothing
//  regexes raw source, so strings/comments/numbers can never be corrupted.
//
//  Pipeline:
//    1. encodeNumbers   — integer literals → arithmetic expressions (opt)
//    2. renameLocals    — conservative, all-or-nothing per name (opt)
//    3. encryptStrings  — string literals → DEC("...",key) calls (always)
//    4. assemble        — decryptStub + junk + transformed user code
//    5. loader.build    — wrap in the self-decrypting anti-tampered loader
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { tokenize, stringValue, KEYWORDS } = require('./lexer');
const ObfuscatorEngine = require('./engine');
const loader = require('./loader');
const antitamper = require('./antitamper');
const vm = require('./vm');
const { rng, randInt } = require('./rng');

// Upper bound for the bit32/XOR number-encoding forms. Lua's bit32 library is
// unsigned-32-bit, and JS `^`/`&` produce SIGNED 32-bit results — the two only
// agree while the value's bit 31 is clear, i.e. val ≤ 0x7FFFFFFF. Above this we
// switch to pure add/multiply splits kept ≤ 2^53 so doubles stay exact.
const NUM_MID_MAX = 0x7FFFFFFF;

// Names that must never be renamed (keywords + globals + Roblox/UNC API).
const RESERVED = new Set([
    ...KEYWORDS,
    '_G', '_ENV', '_VERSION', 'self', 'nil', 'true', 'false',
    'pcall', 'xpcall', 'error', 'assert', 'warn', 'print',
    'tostring', 'tonumber', 'select', 'unpack', 'pairs', 'ipairs', 'next',
    'rawget', 'rawset', 'rawequal', 'rawlen', 'setmetatable', 'getmetatable', 'newproxy',
    'load', 'loadstring', 'loadfile', 'dofile', 'require',
    'getfenv', 'setfenv', 'collectgarbage', 'gcinfo',
    'math', 'string', 'table', 'coroutine', 'os', 'io', 'debug', 'package',
    'bit', 'bit32', 'utf8', 'buffer', 'task', 'vector',
    'game', 'workspace', 'script', 'plugin', 'shared',
    'Instance', 'Vector3', 'Vector2', 'CFrame', 'Color3', 'Enum',
    'tick', 'wait', 'delay', 'spawn', 'typeof',
    'getgenv', 'getrenv', 'getsenv', 'hookfunction', 'hookmetamethod',
    'getrawmetatable', 'setreadonly', 'getnamecallmethod', 'checkcaller',
]);

// Globals worth routing through a local alias (opt-in `indirectGlobals`). These
// are the readable give-aways in exploit/Roblox scripts. We can't rename the
// global itself, but `local _a=getgenv ... _a()` hides the call-site name and
// adds an indirection a static reader has to resolve. Only READ occurrences are
// rewritten, and only when the name is never localized or reassigned.
const INDIRECTABLE_GLOBALS = new Set([
    'getgenv', 'getrenv', 'getsenv', 'getfenv', 'setfenv',
    'hookfunction', 'hookmetamethod', 'newcclosure', 'checkcaller',
    'getrawmetatable', 'setrawmetatable', 'setreadonly', 'isreadonly',
    'getnamecallmethod', 'setnamecallmethod', 'getconnections',
    'firetouchinterest', 'fireproximityprompt', 'fireclickdetector',
    'getgc', 'getreg', 'getinstances', 'getnilinstances', 'getloadedmodules',
    'request', 'writefile', 'readfile', 'appendfile', 'isfile', 'delfile',
    'listfiles', 'makefolder', 'isfolder', 'loadstring', 'identifyexecutor',
]);

// Single source of truth: every indirectable global is also a global that must
// never be renamed. Folding the set into RESERVED here (rather than maintaining
// two hand-written lists) means a name added to INDIRECTABLE_GLOBALS can never
// silently drift out of RESERVED and become a rename candidate. RESERVED is a
// Set, so re-adding names already present is a no-op.
for (const g of INDIRECTABLE_GLOBALS) RESERVED.add(g);

class LuaTransformer {
    constructor() {
        this.engine = new ObfuscatorEngine();
        this.stats = { stringsFound: 0, stringsEncrypted: 0, bytesOriginal: 0, bytesOutput: 0 };
    }

    transform(source, options = {}) {
        const {
            renameVariables = true,
            addJunkCode = true,
            encodeNumbers = true,
            // Opt-in extra layers (default OFF — gated by the runtime test suite).
            splitStrings = false,
            controlFlow = false,
            deepNumbers = false,     // recursive number encoding (larger output)
            virtualizeNumbers = false, // compile integer literals to bytecode + emit a VM
            indirectGlobals = false, // route executor/Roblox globals through aliases
            stringPool = false,      // hoist encrypted strings into one shuffled table
            minStringLength = 1,
            watermark = true,
            seed = null,             // set a number to make this build reproducible
        } = options;

        // Install the RNG seed up-front so EVERY draw in this build (transformer,
        // loader, engine, antitamper) comes from the same deterministic stream.
        // Restored to the previous source in `finally` so one seeded build can't
        // leak determinism into an unrelated later call. Unseeded (seed===null)
        // keeps the historical Math.random behaviour exactly.
        const _rngState = require('./rng');
        const _wasSeeded = _rngState.isSeeded();
        if (seed !== null && seed !== undefined) _rngState.seed(seed);

        this.stats = { stringsFound: 0, stringsEncrypted: 0, bytesOriginal: source.length, bytesOutput: 0 };

        // Per-build VM state (opcode bytes + interpreter names), drawn from the
        // shared RNG so seeded builds are reproducible and every eligible integer
        // routes through the SAME interpreter emitted below. Independent of the
        // decrypt stub's names, so the VM works with string encryption on or off.
        const vmState = virtualizeNumbers
            ? { op: vm.makeOpcodes(randInt), names: vm.makeNames(() => this._rname()) }
            : null;

        let code = source;
        try {
            if (splitStrings) code = this._splitStrings(code);   // before encryption
            if (indirectGlobals) code = this._indirectGlobals(code); // before rename, so aliases get renamed too
            // Number pass. virtualizeNumbers takes over the number pass when set:
            // eligible integers become VM calls; ineligible ones fall back to the
            // arithmetic encoder only when encodeNumbers is also on. This keeps the
            // two flags independent — either can be enabled without the other.
            if (virtualizeNumbers) code = this._virtualizeNumbers(code, vmState, deepNumbers ? 2 : 1, encodeNumbers);
            else if (encodeNumbers) code = this._encodeNumbers(code, deepNumbers ? 2 : 1);
            if (renameVariables) code = this._renameLocals(code);

            const names = this.engine.decryptNames();
            // When the pool layer is on, _encryptStrings accumulates entries into
            // `pool` and emits GET(i) call-sites instead of inline DEC(...) calls.
            // `base` is the per-build secret from which every pool entry's key is
            // derived (key(i) = base XOR mix(i)); no per-entry key array is emitted.
            const pool = stringPool ? { escaped: [], base: this.engine.generateKey(), byValue: new Map() } : null;
            code = this._encryptStrings(code, names, minStringLength, pool);
            if (controlFlow) code = this._controlFlowFlatten(code);

            const stub = this.engine.emitDecryptStub(names);
            // The pool table must be emitted AFTER the decrypt stub (it calls DEC
            // and DERIVE) and BEFORE the user code (which calls GET).
            const poolLua = (pool && pool.escaped.length)
                ? this.engine.emitStringPool(names, pool.escaped, pool.base) + '\n'
                : '';
            // The numeric VM interpreter, likewise, must be defined BEFORE the user
            // code that calls it. Emitted only when the pass produced at least one
            // VM call (vmState.used) — a VM with no callers is dead weight. Uses a
            // seeded Fisher-Yates for the dispatch-arm shuffle so it stays
            // reproducible with the rest of the build.
            const vmLua = (vmState && vmState.used)
                ? vm.emitVM(vmState.names, vmState.op, (arr) => {
                    for (let i = arr.length - 1; i > 0; i--) { const j = randInt(0, i);[arr[i], arr[j]] = [arr[j], arr[i]]; }
                    return arr;
                }) + '\n'
                : '';
            const junk = addJunkCode ? this._generateJunk() : '';
            const inner = stub + '\n' + poolLua + vmLua + junk + '\n' + code;

            const final = loader.build(inner, watermark);
            this.stats.bytesOutput = final.length;
            return final;
        } finally {
            // Never let a seeded build leave the shared RNG in a seeded state for
            // the next (possibly unrelated) call. Restore Math.random unless the
            // caller was already inside a seeded scope.
            if (seed !== null && seed !== undefined && !_wasSeeded) _rngState.seed(null);
        }
    }

    // Polymorphic identifier drawn from the shared RNG (so seeded builds get
    // stable names). Central helper so junk/CFF name generation share one source.
    _rname() {
        return require('./rng').rname(2, 8);
    }

    // ── Pass 1: number encoding ──────────────────────────────────
    // `depth` controls recursion: at depth ≥ 2 the operands of each encoded
    // expression are themselves encoded (much harder to constant-fold, but the
    // output grows ~3-4× per level, so it's opt-in via the `deepNumbers` flag).
    _encodeNumbers(source, depth = 1) {
        const toks = tokenize(source);
        const edits = [];
        for (const t of toks) {
            if (t.type !== 'number') continue;
            const val = this._integerValue(t.value);
            // Skip floats/exponents (val === null). Every non-negative safe
            // integer is now encodable: _encodeOneNumber picks a magnitude-safe
            // form per tier (subtraction/additive for tiny 0-9, the full
            // bit32/MBA arsenal for mid values ≤ 0x7FFFFFFF, and pure
            // add/multiply splits ≤ 2^53 for large values). _integerValue
            // already rejects anything past Number.MAX_SAFE_INTEGER. Hex/binary
            // are normalized to decimal here, so 0xFF / 0b1010 get encoded too —
            // common in Roblox/exploit code, which is hex-heavy.
            if (val === null || val < 0 || !Number.isSafeInteger(val)) continue;
            edits.push({ start: t.start, end: t.end, text: this._encodeOneNumber(val, depth) });
        }
        return this._applyEdits(source, edits);
    }

    // ── Pass 1 (alt): number virtualization ──────────────────────
    // Illunox-style: each eligible integer literal is compiled to bytecode for a
    // per-build stack VM and replaced by a call `VM("<program>",{<consts>})`. One
    // interpreter (emitVM) is emitted per build; the literal never appears in the
    // output. vm.renderNumber verifies (JS twin) that the program reproduces the
    // value before emitting, and returns null on overflow/failure so we fall back
    // gracefully — to the arithmetic encoder if `arithFallback` is on, else the
    // plain literal. `vmState.used` is flipped the first time a call is emitted so
    // the caller only injects the interpreter when it has at least one caller.
    _virtualizeNumbers(source, vmState, depth = 1, arithFallback = false) {
        const toks = tokenize(source);
        const edits = [];
        for (const t of toks) {
            if (t.type !== 'number') continue;
            const val = this._integerValue(t.value);
            if (val === null || val < 0 || !Number.isSafeInteger(val)) continue;
            const call = vm.renderNumber(val, vmState.names, vmState.op, randInt, depth);
            if (call !== null) {
                vmState.used = true;
                edits.push({ start: t.start, end: t.end, text: call });
            } else if (arithFallback) {
                edits.push({ start: t.start, end: t.end, text: this._encodeOneNumber(val, depth) });
            }
        }
        return this._applyEdits(source, edits);
    }

    // Parse a numeric literal token to a non-negative integer, or null if it is
    // not a plain integer (float, exponent, or has a fractional/`.` part). Hex
    // (0x..) and binary (0b..) ARE integers and are converted to decimal.
    // Underscore digit separators (Luau) are stripped first.
    _integerValue(raw) {
        const s = raw.replace(/_/g, '');
        let m;
        if ((m = /^0[xX]([0-9a-fA-F]+)$/.exec(s))) { const v = parseInt(m[1], 16); return Number.isSafeInteger(v) ? v : null; }
        if ((m = /^0[bB]([01]+)$/.exec(s)))         { const v = parseInt(m[1], 2);  return Number.isSafeInteger(v) ? v : null; }
        if (/^\d+$/.test(s)) return parseInt(s, 10);   // plain decimal integer
        return null;                                   // float / exponent / other
    }

    _encodeOneNumber(val, depth = 1) {
        // At depth > 1, encode a non-negative integer OPERAND recursively; else
        // emit it as a plain literal. Every tier below emits operands that are
        // themselves non-negative safe integers, so recursion is always valid
        // and terminates by the depth counter.
        const operand = (n) => {
            if (depth > 1 && Number.isSafeInteger(n) && n >= 0) {
                return this._encodeOneNumber(n, depth - 1);
            }
            return String(n);
        };

        // ── Tiny tier [0, 9] ─────────────────────────────────────
        // The bit32/XOR and additive forms need a positive operand strictly
        // below val, which doesn't exist for 0 and 1. A subtraction offset
        // works for any non-negative val: (val+r) - r. For val ≥ 2 an additive
        // split is also fine. Operands stay tiny — no overflow, no bit32.
        if (val <= 9) {
            if (val >= 2 && randInt(0, 1) === 0) {
                const a = randInt(1, val - 1);
                return `(${operand(a)}+${operand(val - a)})`;
            }
            const r = randInt(1, 0xFFFF);
            return `(${operand(val + r)}-${operand(r)})`;
        }

        // ── Large tier (> 0x7FFFFFFF) ────────────────────────────
        // bit32/XOR forms would diverge here: JS `^` is signed-32-bit, Lua's
        // bit32 is unsigned, and they disagree once bit 31 is set. So use only
        // add/multiply splits, every product kept ≤ val ≤ 2^53 so the doubles
        // Lua computes with stay exact.
        if (val > NUM_MID_MAX) {
            switch (randInt(0, 2)) {
                case 0: {
                    // base*K + rem, K a power of ten. base = floor(val/K), so
                    // base*K ≤ val ≤ 2^53 (exact); rem = val - base*K < K.
                    const K = [10000, 100000, 1000000][randInt(0, 2)];
                    const base = Math.floor(val / K);
                    return `(${operand(base)}*${K}+${operand(val - base * K)})`;
                }
                case 1: {
                    // Additive split; a kept well below val so val-a stays > 0.
                    const a = randInt(1, 0x3FFFFFFF);
                    return `(${operand(a)}+${operand(val - a)})`;
                }
                default: {
                    // base*K + rem with a small random factor K.
                    const K = randInt(2, 9);
                    const base = Math.floor(val / K);
                    return `(${operand(base)}*${K}+${operand(val - base * K)})`;
                }
            }
        }

        // ── Mid tier [10, 0x7FFFFFFF] — full arsenal ─────────────
        switch (randInt(0, 6)) {
            case 0: { const k = randInt(1, 0xFFFF); return `bit32.bxor(${operand(val ^ k)},${k})`; }
            case 1: { const a = randInt(1, val - 1); return `(${operand(a)}+${operand(val - a)})`; }
            case 2: {
                const d = [2, 3, 4, 5, 8][randInt(0, 4)];
                const base = Math.floor(val / d);
                return `(${operand(base)}*${d}+${operand(val - base * d)})`;
            }
            case 3: { const k1 = randInt(1, 0xFFFF), k2 = randInt(1, 0xFFFF); return `bit32.bxor(bit32.bxor(${operand(val ^ k1 ^ k2)},${k1}),${k2})`; }
            // Mixed boolean-arithmetic (MBA) identity: for all non-negative
            // integers, (a XOR b) + 2*(a AND b) == a + b. Exact under doubles
            // (every term ≤ val ≤ 999999), and it resists constant-folding
            // because a folder must know the identity to simplify it.
            case 4: {
                const a = randInt(1, val - 1), b = val - a;
                return `(bit32.bxor(${operand(a)},${operand(b)})+2*bit32.band(${operand(a)},${operand(b)}))`;
            }
            // MBA identity: (a OR b) + (a AND b) == a + b (same guarantees).
            case 5: {
                const a = randInt(1, val - 1), b = val - a;
                return `(bit32.bor(${operand(a)},${operand(b)})+bit32.band(${operand(a)},${operand(b)}))`;
            }
            default: { const a = randInt(1, val - 1); return `(${operand(a)}+${operand(val - a)})`; }
        }
    }

    // ── Pass 2: conservative local renaming ──────────────────────
    // Collect local-declared names. A name is renamed only if EVERY occurrence
    // is in a safe position (not a field after . / :, not a table key). This
    // all-or-nothing rule keeps semantics intact without full scope analysis.
    // Dispatch: try the scope-aware rename first; if it bails (returns null) or
    // throws on a construct it can't resolve precisely, fall back to the proven
    // global-consistent rename. The fallback guarantees output is never *worse*
    // than before this pass existed — only equal or harder to reverse.
    _renameLocals(source) {
        try {
            const scoped = this._renameLocalsScoped(source);
            if (scoped !== null) return scoped;
        } catch { /* fall through to the always-correct global rename */ }
        return this._renameLocalsGlobal(source);
    }

    _renameLocalsGlobal(source) {
        const toks = tokenize(source);
        const meaningful = toks; // lexer already drops whitespace/skips none we care about

        // Build prev-meaningful index helper.
        const candidates = this._collectLocalNames(meaningful);
        if (candidates.size === 0) return source;

        // Determine which candidates are safe (every occurrence safe).
        const unsafe = new Set();
        let braceDepth = 0;
        for (let i = 0; i < meaningful.length; i++) {
            const t = meaningful[i];
            if (t.type === 'punct') {
                if (t.value === '{') braceDepth++;
                else if (t.value === '}') braceDepth = Math.max(0, braceDepth - 1);
            }
            // Backtick interpolation `...{expr}...` is an opaque token, so a
            // rename can't reach the `expr` inside it. Mark any candidate name
            // referenced there as unsafe so we never leave a dangling reference.
            if (t.type === 'backtick') {
                for (const id of this._backtickIdents(t.value)) {
                    if (candidates.has(id)) unsafe.add(id);
                }
                continue;
            }
            if (t.type !== 'name' || !candidates.has(t.value)) continue;
            const prev = meaningful[i - 1];
            const next = meaningful[i + 1];
            // field/method access: a.NAME / a:NAME
            if (prev && prev.type === 'punct' && (prev.value === '.' || prev.value === ':')) { unsafe.add(t.value); continue; }
            // table key:  { NAME = ... } or { NAME : ... }
            if (braceDepth > 0 && next && next.type === 'punct' && (next.value === '=' || next.value === ':')) { unsafe.add(t.value); continue; }
        }

        let counter = 0;
        // Seed `used` with EVERY identifier already in the source so a generated
        // name (e.g. _lI1) can never collide with a user identifier that we are
        // not renaming (a global, a field, or a local we left alone).
        const used = new Set();
        for (const t of meaningful) {
            if (t.type === 'name' || t.type === 'keyword') used.add(t.value);
        }
        const genName = () => {
            let name;
            do {
                counter++;
                const chars = 'lI1';
                name = '_';
                let n = counter;
                while (n > 0) { name += chars[n % 3]; n = Math.floor(n / 3); }
            } while (used.has(name));
            used.add(name);
            return name;
        };

        const map = new Map();
        for (const name of candidates) {
            if (unsafe.has(name) || RESERVED.has(name)) continue;
            map.set(name, genName());
        }
        if (map.size === 0) return source;

        const edits = [];
        braceDepth = 0;
        for (let i = 0; i < meaningful.length; i++) {
            const t = meaningful[i];
            if (t.type !== 'name' || !map.has(t.value)) continue;
            const prev = meaningful[i - 1];
            if (prev && prev.type === 'punct' && (prev.value === '.' || prev.value === ':')) continue;
            edits.push({ start: t.start, end: t.end, text: map.get(t.value) });
        }
        return this._applyEdits(source, edits);
    }

    // ── Scope-aware local renaming ───────────────────────────────
    // A recursive-descent walker over the lexer tokens that resolves every name
    // USE to the binding it refers to, then gives each distinct binding its own
    // fresh name. Unlike the global rename (one source-name → one new name
    // everywhere), two unrelated `x`s in different functions — and a shadowed
    // inner vs. outer `x` — get DIFFERENT output names, so the static
    // "same identifier ⇒ same variable" heuristic no longer holds.
    //
    // Safety contract: every binding gets a GLOBALLY-UNIQUE fresh name (no reuse
    // across scopes), so there is zero capture/collision risk once uses resolve
    // correctly. Correctness therefore reduces to correct scope resolution — and
    // on ANY construct the walker can't resolve with confidence (Luau type
    // annotations, generics, goto/labels) it throws, and _renameLocals falls
    // back to the always-correct global rename. Returns null if there was
    // nothing to do so the caller can decide (kept distinct from a throw).
    _renameLocalsScoped(source) {
        const toks = tokenize(source).filter(t => t.type !== 'comment');
        if (toks.length === 0) return source;

        const self = this;
        const P = { i: 0 };
        const refs = [];          // { start, end, binding } — decls + uses
        const bindings = [];

        // Seed `used` with every identifier already present so a generated name
        // can never collide with a global, field, or a name we leave alone.
        const used = new Set();
        for (const t of toks) if (t.type === 'name' || t.type === 'keyword') used.add(t.value);
        let counter = 0;
        const genName = () => {
            let name;
            do {
                counter++;
                const chars = 'lI1';
                name = '_';
                let n = counter;
                while (n > 0) { name += chars[n % 3]; n = Math.floor(n / 3); }
            } while (used.has(name));
            used.add(name);
            return name;
        };

        const bail = () => { throw new Error('scoped-rename: unresolved construct'); };
        const cur = () => toks[P.i];
        const peek = (k) => toks[P.i + (k || 0)];
        const atEnd = () => P.i >= toks.length;
        const isKw = (t, v) => t && t.type === 'keyword' && t.value === v;
        const isPunct = (t, v) => t && t.type === 'punct' && t.value === v;
        const isTerminator = (t) => t && t.type === 'keyword' &&
            (t.value === 'end' || t.value === 'else' || t.value === 'elseif' || t.value === 'until');
        const isCompoundAssign = (t) => t && t.type === 'punct' && /^(?:[-+*/%^]=|\.\.=)$/.test(t.value);
        const BINOP = new Set(['+', '-', '*', '/', '//', '%', '^', '..', '==', '~=',
            '<', '<=', '>', '>=', '&', '|', '~', '<<', '>>']);
        const isBinaryOp = (t) => (t && t.type === 'punct' && BINOP.has(t.value)) ||
            (t && t.type === 'keyword' && (t.value === 'and' || t.value === 'or'));
        const isUnaryOp = (t) => (t && t.type === 'punct' && (t.value === '-' || t.value === '#' || t.value === '~')) ||
            (t && t.type === 'keyword' && t.value === 'not');
        const isCallArgsStart = (t) => isPunct(t, '(') || isPunct(t, '{') ||
            (t && (t.type === 'string' || t.type === 'longstring' || t.type === 'backtick'));

        const expectPunct = (v) => { if (!isPunct(cur(), v)) bail(); P.i++; };
        const expectKw = (v) => { if (!isKw(cur(), v)) bail(); P.i++; };

        const mkScope = (parent) => ({ parent, vars: new Map() });
        const declare = (scope, tok) => {
            const b = { src: tok.value, newName: null, pinned: false };
            scope.vars.set(tok.value, b);
            bindings.push(b);
            refs.push({ start: tok.start, end: tok.end, binding: b }); // the decl itself
            return b;
        };
        const resolveUse = (scope, tok) => {
            for (let s = scope; s; s = s.parent) {
                const b = s.vars.get(tok.value);
                if (b) { refs.push({ start: tok.start, end: tok.end, binding: b }); return; }
            }
            // not found → free/global; leave untouched
        };
        // Backtick `...{expr}...` is one opaque token we can't edit inside, so any
        // local it references must keep its source name — pin those bindings.
        const pinBacktick = (scope, tok) => {
            for (const id of self._backtickIdents(tok.value)) {
                for (let s = scope; s; s = s.parent) {
                    const b = s.vars.get(id);
                    if (b) { b.pinned = true; break; }
                }
            }
        };
        const skipMatched = (open, close) => { // cur is at `open`
            let depth = 0;
            while (!atEnd()) {
                const t = cur();
                if (isPunct(t, open)) depth++;
                else if (isPunct(t, close)) { depth--; P.i++; if (depth === 0) return; continue; }
                P.i++;
            }
            bail();
        };

        // ── Grammar ──────────────────────────────────────────────
        function parseBlock(scope) {
            while (!atEnd() && !isTerminator(cur())) {
                const before = P.i;
                parseStatement(scope);
                if (P.i === before) bail(); // guard against non-advancing loops
            }
        }

        function parseStatement(scope) {
            const t = cur();
            if (isPunct(t, ';')) { P.i++; return; }
            if (isPunct(t, '::')) bail(); // label
            if (t.type === 'keyword') {
                switch (t.value) {
                    case 'local': return parseLocal(scope);
                    case 'if': return parseIf(scope);
                    case 'while': return parseWhile(scope);
                    case 'for': return parseFor(scope);
                    case 'repeat': return parseRepeat(scope);
                    case 'do': { P.i++; const s = mkScope(scope); parseBlock(s); expectKw('end'); return; }
                    case 'function': return parseFunctionStmt(scope);
                    case 'return': {
                        P.i++;
                        if (!atEnd() && !isTerminator(cur()) && !isPunct(cur(), ';')) parseExprList(scope);
                        if (isPunct(cur(), ';')) P.i++;
                        return;
                    }
                    case 'break': case 'continue': P.i++; return;
                    case 'goto': case 'type': case 'export': return bail();
                    default: return bail();
                }
            }
            // expression statement: assignment target list or a call
            parseExprStatement(scope);
        }

        function parseLocal(scope) {
            P.i++; // 'local'
            if (isKw(cur(), 'function')) {
                P.i++;
                const nt = cur(); if (!nt || nt.type !== 'name') bail();
                P.i++;
                declare(scope, nt);              // visible in its own body (recursion) and after
                return parseFunctionBody(scope);
            }
            const declToks = [];
            for (;;) {
                const nt = cur(); if (!nt || nt.type !== 'name') bail();
                P.i++; declToks.push(nt);
                if (isPunct(cur(), '<')) skipMatched('<', '>'); // <const>/<close> attribute
                if (isPunct(cur(), ':')) bail();                // Luau type annotation
                if (isPunct(cur(), ',')) { P.i++; continue; }
                break;
            }
            if (isPunct(cur(), '=')) { P.i++; parseExprList(scope); } // RHS sees OUTER scope
            for (const nt of declToks) declare(scope, nt);           // now the names become visible
        }

        function parseIf(scope) {
            P.i++; parseExpr(scope); expectKw('then');
            parseBlock(mkScope(scope));
            while (isKw(cur(), 'elseif')) { P.i++; parseExpr(scope); expectKw('then'); parseBlock(mkScope(scope)); }
            if (isKw(cur(), 'else')) { P.i++; parseBlock(mkScope(scope)); }
            expectKw('end');
        }

        function parseWhile(scope) {
            P.i++; parseExpr(scope); expectKw('do'); parseBlock(mkScope(scope)); expectKw('end');
        }

        function parseFor(scope) {
            P.i++; // 'for'
            const vars = [];
            let nt = cur(); if (!nt || nt.type !== 'name') bail();
            P.i++; vars.push(nt);
            while (isPunct(cur(), ',')) { P.i++; nt = cur(); if (!nt || nt.type !== 'name') bail(); P.i++; vars.push(nt); }
            if (isPunct(cur(), ':')) bail(); // typed loop var
            if (isPunct(cur(), '=')) { P.i++; parseExprList(scope); }        // numeric header in enclosing scope
            else if (isKw(cur(), 'in')) { P.i++; parseExprList(scope); }     // generic header in enclosing scope
            else bail();
            expectKw('do');
            const body = mkScope(scope);
            for (const v of vars) declare(body, v);
            parseBlock(body);
            expectKw('end');
        }

        function parseRepeat(scope) {
            P.i++; const s = mkScope(scope); parseBlock(s); expectKw('until'); parseExpr(s); // until sees body scope
        }

        function parseFunctionStmt(scope) {
            P.i++; // 'function'
            let nt = cur(); if (!nt || nt.type !== 'name') bail();
            P.i++; resolveUse(scope, nt); // first name: a local ⇒ rename, else global assignment target
            while (isPunct(cur(), '.')) { P.i++; nt = cur(); if (!nt || nt.type !== 'name') bail(); P.i++; }
            if (isPunct(cur(), ':')) { P.i++; nt = cur(); if (!nt || nt.type !== 'name') bail(); P.i++; }
            parseFunctionBody(scope);
        }

        // Called with cur() positioned at the parameter '(' (name already consumed).
        function parseFunctionBody(scope) {
            if (isPunct(cur(), '<')) bail();  // generic type params ⇒ typed code
            expectPunct('(');
            const fn = mkScope(scope);
            if (!isPunct(cur(), ')')) {
                for (;;) {
                    if (isPunct(cur(), '...')) { P.i++; }
                    else if (cur() && cur().type === 'name') {
                        const p = cur(); P.i++;
                        if (isPunct(cur(), ':')) bail(); // typed parameter
                        declare(fn, p);
                    } else bail();
                    if (isPunct(cur(), ',')) { P.i++; continue; }
                    break;
                }
            }
            expectPunct(')');
            if (isPunct(cur(), ':')) bail(); // return-type annotation
            parseBlock(fn);
            expectKw('end');
        }

        function parseExprStatement(scope) {
            parsePrefixExp(scope);                          // first var or call
            while (isPunct(cur(), ',')) { P.i++; parsePrefixExp(scope); }
            if (isPunct(cur(), '=') || isCompoundAssign(cur())) { P.i++; parseExprList(scope); }
            // else: it was a call statement — nothing more to consume
        }

        function parseExprList(scope) {
            parseExpr(scope);
            while (isPunct(cur(), ',')) { P.i++; parseExpr(scope); }
        }

        function parseExpr(scope) {
            while (isUnaryOp(cur())) P.i++;
            parseSimpleExpr(scope);
            while (isBinaryOp(cur())) {
                P.i++;
                while (isUnaryOp(cur())) P.i++;
                parseSimpleExpr(scope);
            }
        }

        function parseSimpleExpr(scope) {
            const t = cur();
            if (!t) bail();
            if (t.type === 'number' || t.type === 'string' || t.type === 'longstring') { P.i++; return; }
            if (isKw(t, 'nil') || isKw(t, 'true') || isKw(t, 'false')) { P.i++; return; }
            if (isPunct(t, '...')) { P.i++; return; }
            if (t.type === 'backtick') { pinBacktick(scope, t); P.i++; return; }
            if (isPunct(t, '{')) return parseTable(scope);
            if (isKw(t, 'function')) { P.i++; return parseFunctionBody(scope); } // anonymous
            return parsePrefixExp(scope);
        }

        function parsePrefixExp(scope) {
            const t = cur();
            if (isPunct(t, '(')) { P.i++; parseExpr(scope); expectPunct(')'); }
            else if (t && t.type === 'name') { resolveUse(scope, t); P.i++; }
            else bail();
            parseSuffixes(scope);
        }

        function parseSuffixes(scope) {
            for (;;) {
                if (isPunct(cur(), '.')) { P.i++; if (!cur() || cur().type !== 'name') bail(); P.i++; continue; }
                if (isPunct(cur(), '[')) { P.i++; parseExpr(scope); expectPunct(']'); continue; }
                if (isPunct(cur(), ':')) { P.i++; if (!cur() || cur().type !== 'name') bail(); P.i++; parseArgs(scope); continue; }
                if (isCallArgsStart(cur())) { parseArgs(scope); continue; }
                break;
            }
        }

        function parseArgs(scope) {
            const t = cur();
            if (isPunct(t, '(')) { P.i++; if (!isPunct(cur(), ')')) parseExprList(scope); expectPunct(')'); return; }
            if (isPunct(t, '{')) return parseTable(scope);
            if (t && (t.type === 'string' || t.type === 'longstring')) { P.i++; return; }
            if (t && t.type === 'backtick') { pinBacktick(scope, t); P.i++; return; }
            bail();
        }

        function parseTable(scope) {
            expectPunct('{');
            while (!isPunct(cur(), '}')) {
                if (atEnd()) bail();
                if (isPunct(cur(), '[')) {
                    P.i++; parseExpr(scope); expectPunct(']'); expectPunct('='); parseExpr(scope);
                } else if (cur() && cur().type === 'name' && isPunct(peek(1), '=')) {
                    P.i += 2; parseExpr(scope);            // `key = value` — key is not a use
                } else {
                    parseExpr(scope);                       // positional value (may be a use)
                }
                if (isPunct(cur(), ',') || isPunct(cur(), ';')) P.i++; else break;
            }
            expectPunct('}');
        }

        // ── Drive it ─────────────────────────────────────────────
        const chunk = mkScope(null);
        parseBlock(chunk);
        if (!atEnd()) bail(); // leftover tokens ⇒ structural mismatch

        for (const b of bindings) {
            b.newName = (b.pinned || RESERVED.has(b.src)) ? b.src : genName();
        }
        const edits = [];
        for (const r of refs) {
            if (r.binding.pinned || RESERVED.has(r.binding.src)) continue;
            edits.push({ start: r.start, end: r.end, text: r.binding.newName });
        }
        if (edits.length === 0) return source;
        return this._applyEdits(source, edits);
    }

    // ── Opt-in: global indirection ───────────────────────────────
    // Route reads of well-known executor/Roblox globals through local aliases:
    //   local _a=getgenv  ...  _a()   instead of a bare getgenv()
    // Conservative — a global is aliased only if EVERY occurrence is a safe read
    // (never after . / :, never a table key, never reassigned, never inside a
    // backtick interpolation) and the name is never declared as a local. The
    // alias `local NAME=GLOBAL` declarations are prepended to the source.
    _indirectGlobals(source) {
        const toks = tokenize(source);
        // Candidates present in the source and in our curated set.
        const present = new Set();
        for (const t of toks) if (t.type === 'name' && INDIRECTABLE_GLOBALS.has(t.value)) present.add(t.value);
        if (present.size === 0) return source;

        // A candidate localized by the user is not a global here — exclude it.
        const locals = this._collectLocalNames(toks);
        for (const name of [...present]) if (locals.has(name)) present.delete(name);

        // Determine unsafe occurrences.
        const unsafe = new Set();
        let braceDepth = 0;
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.type === 'punct') {
                if (t.value === '{') braceDepth++;
                else if (t.value === '}') braceDepth = Math.max(0, braceDepth - 1);
            }
            if (t.type === 'backtick') {
                for (const id of this._backtickIdents(t.value)) if (present.has(id)) unsafe.add(id);
                continue;
            }
            if (t.type !== 'name' || !present.has(t.value)) continue;
            const prev = toks[i - 1];
            const next = toks[i + 1];
            // field/method access: a.NAME / a:NAME  → not the global
            if (prev && prev.type === 'punct' && (prev.value === '.' || prev.value === ':')) { unsafe.add(t.value); continue; }
            // table key: { NAME = ... } / { NAME : ... }
            if (braceDepth > 0 && next && next.type === 'punct' && (next.value === '=' || next.value === ':')) { unsafe.add(t.value); continue; }
            // reassignment target:  NAME = ...   or   NAME, x = ...   (compound too)
            if (next && next.type === 'punct' && (next.value === '=' || /^[-+*/%^.]+=$/.test(next.value))) { unsafe.add(t.value); continue; }
        }

        const map = new Map();
        const used = new Set();
        for (const t of toks) if (t.type === 'name' || t.type === 'keyword') used.add(t.value);
        let counter = 0;
        const genName = () => {
            let name;
            do { counter++; const chars = 'lI1'; name = '_'; let n = counter; while (n > 0) { name += chars[n % 3]; n = Math.floor(n / 3); } } while (used.has(name));
            used.add(name); return name;
        };
        for (const name of present) { if (!unsafe.has(name)) map.set(name, genName()); }
        if (map.size === 0) return source;

        // Rewrite safe read occurrences.
        const edits = [];
        braceDepth = 0;
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.type !== 'name' || !map.has(t.value)) continue;
            const prev = toks[i - 1];
            if (prev && prev.type === 'punct' && (prev.value === '.' || prev.value === ':')) continue;
            edits.push({ start: t.start, end: t.end, text: map.get(t.value) });
        }
        const rewritten = this._applyEdits(source, edits);
        // Prepend the alias declarations (real global name on the RHS).
        const decls = [...map.entries()].map(([g, a]) => `local ${a}=${g}`).join(' ');
        return decls + ' ' + rewritten;
    }

    // Extract identifier names appearing inside `{...}` interpolation segments
    // of a backtick string token's raw value.
    _backtickIdents(raw) {
        const ids = new Set();
        let depth = 0, expr = '';
        for (let i = 1; i < raw.length; i++) {
            const c = raw[i];
            if (c === '\\') { i++; continue; }
            if (c === '{') { depth++; if (depth === 1) expr = ''; continue; }
            if (c === '}') { if (depth === 1) { for (const m of expr.matchAll(/[A-Za-z_]\w*/g)) ids.add(m[0]); } depth = Math.max(0, depth - 1); continue; }
            if (depth >= 1) expr += c;
        }
        return ids;
    }

    _collectLocalNames(toks) {
        const names = new Set();
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (!(t.type === 'keyword' && t.value === 'local')) continue;
            let j = i + 1;
            // `local function NAME` — collect NAME, it's a local.
            if (toks[j] && toks[j].type === 'keyword' && toks[j].value === 'function') {
                if (toks[j + 1] && toks[j + 1].type === 'name') names.add(toks[j + 1].value);
                continue;
            }
            // `local a, b, c [: T] [<attr>] [= ...]` — collect names up to `=`/EOL.
            while (j < toks.length) {
                const tok = toks[j];
                if (tok.type === 'name') {
                    names.add(tok.value);
                    // skip optional `: type` and `<attr>` until comma or end
                    j++;
                    while (j < toks.length) {
                        const nx = toks[j];
                        if (nx.type === 'punct' && nx.value === ',') { j++; break; }
                        if (nx.type === 'punct' && nx.value === '=') { j = toks.length; break; }
                        if (nx.type === 'keyword') { j = toks.length; break; }
                        j++;
                    }
                } else break;
            }
        }
        // Collect for-loop variables (also locals):
        //   numeric:  for i = a, b [, c] do
        //   generic:  for k, v, ... in expr do
        // In both forms the loop variables are the names between `for` and the
        // terminating `=` (numeric) or `in` (generic) keyword.
        for (let i = 0; i < toks.length; i++) {
            if (!(toks[i].type === 'keyword' && toks[i].value === 'for')) continue;
            let j = i + 1;
            while (j < toks.length) {
                const tok = toks[j];
                if (tok.type === 'name') { names.add(tok.value); j++; continue; }
                if (tok.type === 'punct' && tok.value === ',') { j++; continue; }
                // `=` (numeric for) or `in` (generic for) ends the variable list.
                break;
            }
        }
        // Also collect function parameter names (also locals).
        for (let i = 0; i < toks.length; i++) {
            if (!(toks[i].type === 'keyword' && toks[i].value === 'function')) continue;
            // find the opening paren
            let j = i + 1;
            while (j < toks.length && !(toks[j].type === 'punct' && toks[j].value === '(')) {
                // stop if we hit another statement boundary unexpectedly
                if (toks[j].type === 'keyword') break;
                j++;
            }
            if (!(toks[j] && toks[j].type === 'punct' && toks[j].value === '(')) continue;
            j++;
            while (j < toks.length && !(toks[j].type === 'punct' && toks[j].value === ')')) {
                if (toks[j].type === 'name') names.add(toks[j].value);
                j++;
            }
        }
        return names;
    }

    // ── Pass 3: string encryption ────────────────────────────────
    // Default: each literal becomes an inline `DEC("...",key)` call.
    // Pool mode (`pool` object supplied): identical literals are de-duplicated
    // and hoisted into a shuffled table; each call-site becomes `GET(i)`. The
    // inline path is byte-for-byte unchanged when `pool` is null, so the pool
    // layer can only ever affect output when explicitly enabled.
    _encryptStrings(source, names, minLen, pool = null) {
        const toks = tokenize(source);
        this.stats.stringsFound = toks.filter(t => t.type === 'string' || t.type === 'longstring').length;
        const edits = [];
        // Pool bookkeeping: dedupe by decoded value → a temp id; each occurrence
        // records {editIndex, tempId, wrap}. Final indices are assigned after a
        // shuffle so the table order doesn't mirror source order.
        const poolValues = pool ? [] : null;   // tempId → decoded string value
        const poolByValue = pool ? new Map() : null;
        const poolRefs = pool ? [] : null;     // { editIndex, tempId, wrap }

        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.type !== 'string' && t.type !== 'longstring') continue;
            const value = stringValue(t);
            if (value.length < minLen) continue;

            // Bracketless call?  prefixexp STRING  →  prefixexp((expr))
            // True only when the previous meaningful token is a value that the
            // string is being *called on*: a name, ')' or ']'.
            const prev = toks[i - 1];
            const wrap = !!(prev && (prev.type === 'name' ||
                (prev.type === 'punct' && (prev.value === ')' || prev.value === ']'))));

            if (pool) {
                // Dedupe identical decoded values (same value → same entry). The
                // key is index-derived, so encryption is deferred until the final
                // shuffled index is known (below); here we only record the value.
                let tempId = poolByValue.get(value);
                if (tempId === undefined) {
                    tempId = poolValues.length;
                    poolValues.push(value);
                    poolByValue.set(value, tempId);
                }
                poolRefs.push({ editIndex: edits.length, tempId, wrap });
                edits.push({ start: t.start, end: t.end, text: '' }); // filled after shuffle
                this.stats.stringsEncrypted++;
                continue;
            }

            const key = this.engine.generateKey();
            const enc = this.engine.encryptToLua(value, key);
            let expr = `${names.DEC}("${enc.escaped}",${key})`;
            if (wrap) expr = '(' + expr + ')';
            edits.push({ start: t.start, end: t.end, text: expr });
            this.stats.stringsEncrypted++;
        }

        if (pool && poolValues.length) {
            // Shuffle the unique entries and build a tempId → final 1-based index
            // map, then fill the deferred edit texts with GET(finalIndex). Each
            // entry is encrypted here (not on discovery) because its key is
            // derived from the FINAL shuffled index: key(i) = base XOR mix(i).
            const order = poolValues.map((_, i) => i);
            for (let i = order.length - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1));
                [order[i], order[j]] = [order[j], order[i]];
            }
            const finalOf = new Array(poolValues.length);
            order.forEach((tempId, pos) => {
                const idx = pos + 1;                  // Lua tables are 1-based
                finalOf[tempId] = idx;
                const key = this.engine.deriveKey(pool.base, idx);
                const enc = this.engine.encryptToLua(poolValues[tempId], key);
                pool.escaped.push(enc.escaped);
            });
            for (const ref of poolRefs) {
                let expr = `${names.GET}(${finalOf[ref.tempId]})`;
                if (ref.wrap) expr = '(' + expr + ')';
                edits[ref.editIndex].text = expr;
            }
        }

        return this._applyEdits(source, edits);
    }

    // Apply a set of {start,end,text} edits to source. Edits must not overlap.
    _applyEdits(source, edits) {
        if (edits.length === 0) return source;
        edits.sort((a, b) => b.start - a.start); // right-to-left
        let out = source;
        for (const e of edits) {
            out = out.slice(0, e.start) + e.text + out.slice(e.end);
        }
        return out;
    }

    // ── Opt-in: string splitting ─────────────────────────────────
    // Rewrite a short string literal into a parenthesised concat of 2–4 pieces:
    //   "hello world"  →  ("hel".."lo wo".."rld")
    // Runs BEFORE encryption, so each piece becomes its own DEC(...) call.
    // Token-based: only touches `string` tokens, never code or interpolation.
    _splitStrings(source) {
        const toks = tokenize(source);
        const edits = [];
        for (const t of toks) {
            if (t.type !== 'string') continue;
            const q = t.quote;
            const inner = t.value.slice(1, -1);           // raw body (escapes kept verbatim)
            if (inner.length < 6) continue;               // too short to bother
            // Split on escape-safe boundaries: never cut between '\' and its escaped char.
            const cuts = this._safeSplitPoints(inner, randInt(1, 3));
            if (cuts.length === 0) continue;
            const pieces = [];
            let prev = 0;
            for (const c of cuts) { pieces.push(inner.slice(prev, c)); prev = c; }
            pieces.push(inner.slice(prev));
            const expr = '(' + pieces.map(p => q + p + q).join('..') + ')';
            edits.push({ start: t.start, end: t.end, text: expr });
        }
        return this._applyEdits(source, edits);
    }

    // Pick up to `n` cut positions in [1, len-1] that don't fall right after an
    // unescaped backslash (which would split an escape sequence).
    _safeSplitPoints(s, n) {
        const valid = [];
        for (let i = 1; i < s.length; i++) {
            // Never cut between the halves of a surrogate pair (e.g. an emoji):
            // s.charCodeAt(i) being a low surrogate means i-1 is its high half,
            // and splitting here would leave two lone surrogates → mojibake.
            const cc = s.charCodeAt(i);
            if (cc >= 0xDC00 && cc <= 0xDFFF) continue;
            // Count preceding backslashes — odd means i is mid-escape.
            let b = 0, j = i - 1;
            while (j >= 0 && s[j] === '\\') { b++; j--; }
            if (b % 2 === 0) valid.push(i);
        }
        if (valid.length === 0) return [];
        // Choose n distinct points, sorted ascending.
        const chosen = new Set();
        for (let k = 0; k < n && valid.length; k++) chosen.add(valid[randInt(0, valid.length - 1)]);
        return [...chosen].sort((a, b) => a - b);
    }

    // Token-based hoisting of a single top-level statement for CFF. Returns
    // { names: string[], body: string } where `names` are locals to hoist to
    // the enclosing scope and `body` is the statement rewritten to assign (not
    // re-declare) them. Non-`local` statements pass through unchanged.
    //   local function f() ... end   → names:[f]      body: "f=function() ... end"
    //   local a,b = 1,2              → names:[a,b]    body: "a,b = 1,2"
    //   local a: T<x>, b = ...       → names:[a,b]    body: "a, b = ..."  (types dropped from LHS)
    //   local a,b                    → names:[a,b]    body: ""            (no init)
    _hoistLocalStmt(stmt) {
        const toks = tokenize(stmt);
        if (!(toks[0] && toks[0].type === 'keyword' && toks[0].value === 'local')) {
            return { names: [], body: stmt };
        }
        // local function NAME ...  →  NAME=function ...
        if (toks[1] && toks[1].type === 'keyword' && toks[1].value === 'function' && toks[2] && toks[2].type === 'name') {
            const name = toks[2].value;
            // Rewrite by slicing the source: replace "local function NAME" prefix.
            const afterName = toks[2].end;
            const body = `${name}=function${stmt.slice(afterName)}`;
            return { names: [name], body };
        }
        // local <namelist> [= <exprlist>].  Collect names at bracket-depth 0,
        // stopping at the top-level `=` (the init) or end of statement. Skip
        // `: type` annotations and `<attr>`/generic segments between names.
        const names = [];
        let depth = 0, eqTok = null, i = 1;
        for (; i < toks.length; i++) {
            const t = toks[i];
            if (t.type === 'punct') {
                if (t.value === '(' || t.value === '[' || t.value === '{' || t.value === '<') depth++;
                else if (t.value === ')' || t.value === ']' || t.value === '}' || t.value === '>') { if (depth > 0) depth--; }
                else if (t.value === '=' && depth === 0) { eqTok = t; break; }
                continue;
            }
            // A name at depth 0 that immediately follows `local` or a `,` is a
            // declared local (not part of a type annotation, which sits at depth
            // 0 only after a `:` — and we skip until the next comma on seeing `:`).
            if (t.type === 'name' && depth === 0) {
                const prev = toks[i - 1];
                if (prev && (prev.value === 'local' || prev.value === ',')) names.push(t.value);
            }
            if (t.type === 'punct' && t.value === ':' && depth === 0) {
                // skip the type until the next top-level comma or the `=`
                let d2 = 0;
                for (i++; i < toks.length; i++) {
                    const u = toks[i];
                    if (u.type === 'punct') {
                        if (u.value === '(' || u.value === '[' || u.value === '{' || u.value === '<') d2++;
                        else if (u.value === ')' || u.value === ']' || u.value === '}' || u.value === '>') { if (d2 > 0) d2--; }
                        else if (d2 === 0 && u.value === ',') break;
                        else if (d2 === 0 && u.value === '=') { eqTok = u; break; }
                    }
                }
                if (eqTok) break;
            }
        }
        if (eqTok) {
            // Rewrite "local <...> = <init>" as "<names> = <init>" — keep the
            // original init expression verbatim (from just after `=`).
            const body = `${names.join(',')} =${stmt.slice(eqTok.end)}`;
            return { names, body };
        }
        // No initializer: fully hoisted, empty branch body.
        return { names, body: '' };
    }

    // Remove comment tokens from `source`, replacing each with a single space
    // so adjacent tokens never fuse. Token-based, so strings/longstrings that
    // merely LOOK like comments are untouched. Used by CFF: a branch body is
    // emitted on one line followed by ` _st=<next>`, and a LINE comment (`-- …`)
    // anywhere in a body would comment out that state update AND the following
    // `elseif`, producing structurally broken Lua (`'end' expected near 'elseif'`
    // → the loader's `UmbraX: load failed`). The demo's leading `-- …` header was
    // exactly this case. Comments carry no runtime semantics, so dropping them
    // before flattening is safe and fixes the whole class.
    _stripComments(source) {
        const toks = tokenize(source);
        const edits = [];
        for (const t of toks) {
            if (t.type === 'comment') edits.push({ start: t.start, end: t.end, text: ' ' });
        }
        return this._applyEdits(source, edits);
    }

    // ── Opt-in: light control-flow flattening ────────────────────
    // Wrap the top-level statement sequence in a state-machine dispatch loop.
    // Conservative: only flattens when statements split cleanly at depth-0
    // boundaries, and hoists top-level `local` declarations so cross-statement
    // references survive (each branch is its own scope).
    _controlFlowFlatten(source) {
        // Drop comments first — a line comment in a branch body would swallow the
        // injected ` _st=<next>` state update (and the following `elseif`). See
        // _stripComments. This is the fix for CFF breaking on any commented input.
        source = this._stripComments(source);
        const stmts = this._splitTopLevelStatements(source);
        if (stmts.length < 3) return source;             // not worth it / too risky

        // Hoist `local` names so they stay visible across branches. Token-based
        // (see _hoistLocalStmt) so table literals with commas/`=` inside braces
        // (`local t = {a=1, b=2}`) are handled correctly.
        const hoisted = [];
        const seen = new Set();
        const bodies = stmts.map((raw) => {
            const stmt = raw.trim();
            const h = this._hoistLocalStmt(stmt);
            for (const nm of h.names) if (!seen.has(nm)) { seen.add(nm); hoisted.push(nm); }
            return h.body;
        });

        const stVar = this._rname();
        const ids = [];
        const used = new Set();
        for (let i = 0; i <= stmts.length; i++) { let id; do { id = randInt(100, 99999); } while (used.has(id)); used.add(id); ids.push(id); }

        let code = '';
        if (hoisted.length) code += `local ${hoisted.join(',')} `;
        code += `local ${stVar}=${ids[0]} while true do `;
        for (let i = 0; i < stmts.length; i++) {
            const prefix = i === 0 ? 'if' : 'elseif';
            const next = i < stmts.length - 1 ? ids[i + 1] : ids[stmts.length];
            // Skip the state update ONLY for a chunk-terminating top-level
            // `return` (appending `_st=next` after it would be invalid Lua).
            // A `return` nested in a function/if-block is NOT terminating — the
            // old regex matched those too and produced a dead state that never
            // advanced (infinite loop). Check depth-0 returns only.
            const hasReturn = this._hasTopLevelReturn(bodies[i]);
            const upd = hasReturn ? '' : ` ${stVar}=${next}`;
            code += `${prefix} ${stVar}==${ids[i]} then ${bodies[i]}${upd} `;
        }
        code += `elseif ${stVar}==${ids[stmts.length]} then break else break end end `;
        return code;
    }

    // True if `src` contains a `return` keyword at block depth 0 — i.e. one that
    // terminates this chunk. Returns nested inside function/do/then/repeat blocks
    // don't count (they don't end the dispatch branch).
    _hasTopLevelReturn(src) {
        const toks = tokenize(src);
        let depth = 0;
        const opens = new Set(['function', 'do', 'then', 'repeat']);
        for (const t of toks) {
            if (t.type !== 'keyword') continue;
            if (t.value === 'return' && depth === 0) return true;
            if (opens.has(t.value)) depth++;
            else if (t.value === 'end' || t.value === 'until') { if (depth > 0) depth--; }
        }
        return false;
    }

    // Split into top-level statements at depth-0 boundaries (after `end`/`until`/`;`
    // or before a fresh `local`). Token-based via lexer offsets.
    _splitTopLevelStatements(source) {
        const toks = tokenize(source);
        const parts = [];
        let depth = 0, bracket = 0, start = 0;
        const opens = new Set(['function', 'do', 'then', 'repeat']);
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.type === 'punct') {
                if (t.value === '(' || t.value === '[' || t.value === '{') bracket++;
                else if (t.value === ')' || t.value === ']' || t.value === '}') { if (bracket > 0) bracket--; }
                else if (t.value === ';' && depth === 0 && bracket === 0) {
                    const seg = source.slice(start, t.end).trim();
                    if (seg) { parts.push(seg); start = t.end; }
                }
                continue;
            }
            if (t.type !== 'keyword') continue;
            if (opens.has(t.value)) depth++;
            else if (t.value === 'end' || t.value === 'until') {
                if (depth > 0) depth--;
                if (depth === 0 && bracket === 0) {
                    const seg = source.slice(start, t.end).trim();
                    if (seg) { parts.push(seg); start = t.end; }
                }
            } else if (t.value === 'local' && depth === 0 && bracket === 0 && t.start > start) {
                const seg = source.slice(start, t.start).trim();
                if (seg) { parts.push(seg); start = t.start; }
            }
        }
        const tail = source.slice(start).trim();
        if (tail) parts.push(tail);
        return parts;
    }

    // ── Junk generation (runtime opaque-predicate blocks only) ───
    // Every block here branches on a value that is ONLY knowable at runtime —
    // the hex address inside a fresh table's tostring, a pcall/error verdict,
    // the length of an address string. A static deobfuscator running dead-code
    // elimination / constant-folding cannot decide these branches, so it can't
    // prove the block is inert and strip it. (Pure-dead decoys — unused locals,
    // statically-foldable `if 1234>5679`, constant pools — were retired: a
    // liveness pass deletes them for free, so they only inflated size without
    // costing a reverser anything.) Both branches of each block write only
    // locals scoped inside the do…end, so the net runtime effect is always nil
    // regardless of which way the opaque predicate resolves.
    _generateJunk() {
        const n = () => this._rname();
        const r = () => randInt(1000, 9999);
        const blocks = [
            // Fresh-table address parity: #"table: 0x...." %2 is address-derived.
            () => { const a = n(), b = n(); return `do local ${a}=#tostring({})%2 local ${b} if ${a}==0 then ${b}=${r()} else ${b}=${r()} end end `; },
            // Address value mod 3, both branches write a local only.
            () => { const a = n(), c = n(); return `do local ${a}=(#tostring({})+${r()})%3 local ${c}=0 if ${a}>0 then ${c}=bit32.band(${a},255) else ${c}=${r()} end end `; },
            // pcall verdict on a metatable+tostring op — result is runtime state.
            () => { const ok = n(), a = n(); return `do local ${ok}=pcall(function() return #tostring(setmetatable({},{})) end) local ${a} if ${ok} then ${a}=${r()} else ${a}=${r()} end end `; },
            // Length of a fresh address string; the threshold straddles typical
            // pointer-width so a folder can't prove which way it goes.
            () => { const a = n(), b = n(); return `do local ${a}=tostring({}) local ${b}=${r()} if #${a}>${randInt(7, 9)} then ${b}=bit32.bxor(${b},${r()}) end end `; },
            // pcall(error, x) always throws → false, but deciding that requires
            // modelling error() semantics, which static folders don't.
            () => { const ok = n(), a = n(); return `do local ${ok}=pcall(error,${r()}) local ${a}=${r()} if not ${ok} then ${a}=bit32.band(${a},${r()}) end end `; },
            // Two independent fresh-table addresses combined; parity is runtime.
            () => { const a = n(), b = n(), c = n(); return `do local ${a}=#tostring({}) local ${b}=#tostring({}) local ${c}=${r()} if (${a}+${b})%2==0 then ${c}=bit32.bxor(${c},${r()}) else ${c}=${r()} end end `; },
        ];
        let out = '';
        const count = randInt(5, 9);
        for (let i = 0; i < count; i++) out += blocks[randInt(0, blocks.length - 1)]();
        return out;
    }

    getStats() {
        return {
            ...this.stats,
            ratio: this.stats.bytesOriginal > 0 ? (this.stats.bytesOutput / this.stats.bytesOriginal).toFixed(1) : '0',
            antiTamperChecks: antitamper.checkCount(),
            encryptionType: 'CFB stream cipher + XOR-base64 loader + anti-tamper',
        };
    }
}

module.exports = LuaTransformer;
