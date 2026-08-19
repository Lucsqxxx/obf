// ═══════════════════════════════════════════════════════════════
//  UmbraX — Whole-Script Loader / Packer
//
//  Wraps the (already string-encrypted, junked) inner script in a
//  self-decrypting Lua loader. Two layers, each with a JS encoder and a
//  Lua decoder that are obvious inverses (and a JS-twin self-test proves it):
//
//    Layer A (outer):  LCG keystream XOR over the whole byte stream.
//    Layer B (inner):  split into chunks → per-chunk xorshift stream cipher
//                       → shuffled-alphabet base64. Decoys + shuffled order;
//                       a mapping table records the real-chunk order.
//
//  The anti-tamper checks (see antitamper.js) are emitted around the
//  reconstruction + loadstring. Emitted Lua uses `_E`/`_U`/`_S` placeholders
//  that are substituted for the real polymorphic env/unpack/select names.
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const AT = require('./antitamper');
const { rng, randInt, rname } = require('./rng');

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// xorshift32 (matches emitted Lua)
function xs32(s) {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s >>> 0;
}

// LCG byte (matches emitted Lua): state = (state*1103515245+12345) & 0x7FFFFFFF
function lcgNext(s) {
    // 1103515245 needs exact 32→ use mul via doubles is unsafe; emulate Lua's
    // own arithmetic (Lua also computes in doubles then &0x7FFFFFFF). Keep the
    // product within 2^53 by splitting.
    const al = s & 0xFFFF, ah = s >>> 16;
    const lo = al * 1103515245;
    const hi = ((ah * 1103515245) & 0xFFFF) * 0x10000;
    return (((lo + hi) >>> 0) + 12345) & 0x7FFFFFFF;
}

// Standard base64 (MSB-first) over a custom alphabet.
function b64enc(bytes, alpha) {
    let res = '';
    for (let k = 0; k < bytes.length; k += 3) {
        const b1 = bytes[k], b2 = bytes[k + 1] || 0, b3 = bytes[k + 2] || 0;
        const c = (b1 << 16) | (b2 << 8) | b3;
        res += alpha[(c >> 18) & 63] + alpha[(c >> 12) & 63]
            + (k + 1 < bytes.length ? alpha[(c >> 6) & 63] : '=')
            + (k + 2 < bytes.length ? alpha[c & 63] : '=');
    }
    return res;
}

/**
 * Encode `script` (a JS string of inner Lua source) into the artefacts the
 * Lua loader needs. Returns { alphabet, xorKey, globalSeed, chunks[], mapping[],
 * payloadHash }.
 */
function encode(script) {
    const bytes = Array.from(Buffer.from(script, 'utf8'));
    // Per-build djb2 seed: kills the static `5381` fingerprint the integrity
    // bomb used to emit verbatim. Threaded into both the hash and its emitted
    // Lua checker (build → payloadHashGuard) so the two stay exact inverses.
    //
    // Range capped at 0x7FFFFFFF (NOT 0xFFFFFFFF): the guard emits the seed as a
    // bare decimal literal `local _ih=<seed>`, and a VM with a 32-bit lua_Integer
    // (fengari; also the widest-compatible assumption) parses any literal above
    // 2^31-1 as a FLOAT — the first `bit32` op on which raises "no integer
    // representation", bricking the whole loader. Seeds <=0x7FFFFFFF are always
    // integer-valued, and djb2 self-matches for any initial value, so this keeps
    // 2^31 distinct fingerprints while staying integer-safe on every VM.
    const payloadHashSeed = randInt(1, 0x7FFFFFFF);
    const payloadHash = AT.computePayloadHash(script, payloadHashSeed);

    // Layer A — outer LCG keystream XOR.
    const xorKey = randInt(0x100000, 0x7FFFFF);
    const layerA = new Array(bytes.length);
    let xk = xorKey;
    for (let i = 0; i < bytes.length; i++) {
        xk = lcgNext(xk);
        layerA[i] = bytes[i] ^ (xk & 0xFF);
    }

    // Layer B — chunk + per-chunk xorshift stream + base64.
    const alphabet = shuffle('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/'.split('')).join('');
    const globalSeed = randInt(1, 0x7FFFFFFF);
    const chunkSize = Math.max(8, Math.floor(layerA.length / 48) + 1);

    const real = []; // { data, idx }
    for (let idx = 0; idx * chunkSize < layerA.length; idx++) {
        const start = idx * chunkSize;
        const slice = layerA.slice(start, start + chunkSize);
        let st = (globalSeed ^ idx) >>> 0;
        const enc = new Array(slice.length);
        for (let j = 0; j < slice.length; j++) {
            st = xs32(st);
            enc[j] = slice[j] ^ (st & 0xFF);
        }
        real.push({ data: b64enc(enc, alphabet), idx });
    }

    // Build array with decoys, shuffle, record mapping (idx → array position).
    const arr = real.map(r => ({ data: r.data, idx: r.idx, isReal: true }));
    const decoyCount = randInt(10, 25);
    for (let i = 0; i < decoyCount; i++) {
        const len = randInt(12, 28);
        const fake = Array.from({ length: len }, () => alphabet[randInt(0, 63)]).join('');
        arr.push({ data: fake, idx: -1, isReal: false });
    }
    shuffle(arr);

    // mapping[t] = 1-based array position of the chunk whose original idx = t-1
    const posByIdx = new Array(real.length);
    arr.forEach((c, pos) => { if (c.isReal) posByIdx[c.idx] = pos + 1; });

    return {
        alphabet,
        xorKey,
        globalSeed,
        chunks: arr.map(c => c.data),
        mapping: posByIdx,
        payloadHash,
        payloadHashSeed,
    };
}

/**
 * Build the full Lua loader source for `script`.
 * @param script    inner Lua source (already obfuscated)
 * @param watermark whether to prepend a comment watermark
 */
function build(script, watermark = true) {
    const E = encode(script);

    // ── polymorphic name set ─────────────────────────────────────
    const v = {
        a: rname(), sc: rname(), sub: rname(), cc: rname(),
        bx: rname(), bnd: rname(), bls: rname(), brs: rname(),
        p: rname(), stR: rname(), ld: rname(),
        sn: rname(), fs: rname(), fails: rname(),
        idx64: rname(), alpha: rname(), dec: rname(),
        inp: rname(), map: rname(), gseed: rname(), xk: rname(),
        ok: rname(), fn: rname(), res: rname(),
    };
    const encStr = (s) => s.split('').map(c => `${v.sc}(${c.charCodeAt(0)})`).join('..');

    const L = [];
    const envP = rname(2, 6), unpP = rname(2, 6), selP = rname(2, 6);
    // Key-gate multiplier: folded into the outer-cipher seed, scaled by
    // floor(sandboxFailures / THRESHOLD). Sized so the worst case (all ~18
    // probes failing → floor 4 → 4*mul) plus xorKey stays a positive int < 2^31.
    const keyGateMul = randInt(0x10000, 0x400000);
    const wmHash = randInt(0, 0xFFFFFFFF).toString(16);
    const wm = watermark ? `--[[ obfuscated by UmbraX | ${wmHash} ]] ` : '';

    L.push(wm + `return(function(_E,_U,_S,...)`);

    // ── bit32 shim (universal-Lua fallback) ─────────────────────────
    // Luau and Lua 5.2/5.3 ship a `bit32` library; Lua 5.4 REMOVED it (and uses
    // native operators the Luau parser can't even read). So when `bit32` is
    // absent we install a pure-ARITHMETIC polyfill — no `&`/`<<`/`~` operators,
    // so this same source still parses under Luau. It's written onto the shared
    // env table, so both this loader AND the decrypted inner script (which use a
    // bare `bit32` global) pick it up. On Luau/5.3 the guard is false and the
    // native library is used untouched. Only band/bor/bxor(binary), bnot,
    // lshift, rshift, lrotate are emitted, so only those are provided.
    L.push(`if not _E.bit32 then`);
    L.push(`local _umxfl=_E.math.floor`);
    L.push(`local function _umxb(a,b,o) a=a%4294967296 b=b%4294967296 local r,p=0,1 for _i=1,32 do local x=a%2 local y=b%2 a=(a-x)/2 b=(b-y)/2 local d=0 if o==0 then if x+y==2 then d=1 end elseif o==1 then if x+y>=1 then d=1 end else if x~=y then d=1 end end r=r+d*p p=p*2 end return r end`);
    L.push(`local function _umxls(x,n) if n<0 then return _umxfl((x%4294967296)/(2^(-n))) end if n>=32 then return 0 end return (x*(2^n))%4294967296 end`);
    L.push(`local function _umxrs(x,n) if n<0 then return (x*(2^(-n)))%4294967296 end if n>=32 then return 0 end return _umxfl((x%4294967296)/(2^n)) end`);
    L.push(`_E.bit32={band=function(a,b) return _umxb(a,b,0) end,bor=function(a,b) return _umxb(a,b,1) end,bxor=function(a,b) return _umxb(a,b,2) end,bnot=function(a) return 4294967295-(a%4294967296) end,lshift=_umxls,rshift=_umxrs,lrotate=function(x,n) n=n%32 return (_umxls(x,n)+_umxrs(x,32-n))%4294967296 end}`);
    L.push(`end`);

    // localize primitives
    L.push(`${v.sc}=_E.string.char`);
    L.push(`${v.a},${v.sub},${v.cc}=_E.string.byte,_E.string.sub,_E.table.concat`);
    L.push(`${v.bx},${v.bnd},${v.bls},${v.brs}=_E.bit32.bxor,_E.bit32.band,_E.bit32.lshift,_E.bit32.rshift`);
    L.push(`${v.p},${v.stR},${v.ld}=_E.pcall,_E.tostring,(_E.loadstring or _E.load)`);

    // anti-tamper: hook guard + char integrity (sc already localized)
    for (const ln of AT.hookGuard(encStr)) L.push(ln);
    for (const ln of AT.charIntegrity(v)) L.push(ln);

    // base64 index table
    L.push(`${v.alpha}="${E.alphabet}"`);
    L.push(`${v.idx64}={}`);
    L.push(`for _qi=1,64 do ${v.idx64}[${v.sub}(${v.alpha},_qi,_qi)]=_qi-1 end`);

    // per-chunk decode: base64 → xorshift stream decrypt
    L.push(`${v.dec}=function(s,seed)`);
    L.push(`local o,acc,bits,n,st={},0,0,0,${v.bnd}(seed,0xFFFFFFFF)`);
    L.push(`for _qi=1,#s do`);
    L.push(`local ch=${v.sub}(s,_qi,_qi)`);
    L.push(`if ch=="=" then break end`);
    L.push(`local val=${v.idx64}[ch]`);
    L.push(`if val then acc=acc*64+val bits=bits+6`);
    L.push(`if bits>=8 then bits=bits-8`);
    L.push(`local byte=${v.bnd}(${v.brs}(acc,bits),0xFF)`);
    L.push(`st=${v.bnd}(${v.bx}(st,${v.bls}(st,13)),0xFFFFFFFF)`);
    L.push(`st=${v.bx}(st,${v.brs}(st,17))`);
    L.push(`st=${v.bnd}(${v.bx}(st,${v.bls}(st,5)),0xFFFFFFFF)`);
    L.push(`n=n+1 o[n]=${v.sc}(${v.bnd}(${v.bx}(byte,${v.bnd}(st,0xFF)),0xFF))`);
    L.push(`acc=${v.bnd}(acc,${v.bls}(1,bits)-1)`);
    L.push(`end end end`);
    L.push(`return ${v.cc}(o)`);
    L.push(`end`);

    // data + mapping
    L.push(`${v.inp}={${E.chunks.map(c => `[=[${c}]=]`).join(',')}}`);
    L.push(`${v.map}={${E.mapping.join(',')}}`);
    L.push(`${v.gseed}=${E.globalSeed}`);

    // reconstruct layer A bytes
    L.push(`local _parts={}`);
    L.push(`for _t=1,#${v.map} do`);
    L.push(`local _pos=${v.map}[_t]`);
    L.push(`_parts[_t]=${v.dec}(${v.inp}[_pos],${v.bx}(${v.gseed},_t-1))`);
    L.push(`end`);
    L.push(`${v.fs}=${v.cc}(_parts)`);

    // anti-tamper: define the sandbox detector and capture its failure COUNT
    // ONCE, BEFORE decryption, so the same verdict can (a) key-gate the outer
    // cipher below and (b) arm the retained hang bomb further down. Running the
    // probe suite once matters — several probes have genv side-effects and a
    // dedup guard, so a second call would self-trip.
    for (const ln of AT.sandboxFn(v)) L.push(ln);
    L.push(`local ${v.fails}=${v.sn}()`);

    // reverse outer LCG-XOR  (KEY-GATED by the sandbox verdict)
    // CRITICAL (Luau): the LCG step is `xk = (xk*1103515245 + 12345) & 0x7FFFFFFF`.
    // A bare `xk*1103515245` overflows 2^53 (xk up to ~2^31 → product ~2^61) and
    // Luau numbers are DOUBLES, so the low bits are silently lost → wrong
    // keystream → garbage payload. We reproduce the JS lcgNext() 16-bit split
    // (see top of file) so the product never exceeds 2^53 and stays bit-exact.
    // Lua 5.3 (fengari, 64-bit ints) hid this — hence the earlier miss.
    //
    // KEY-GATE: the seed gets `floor(fails/THRESHOLD)*mul` added. That term is
    // EXACTLY 0 while fails is in the tolerance band [0, THRESHOLD-1] — which
    // covers every faithful executor (fails ~0) and every offline run (v.sn()
    // early-returns 0 when there's no game). At/above the bomb threshold it
    // becomes non-zero, so an instrumented deobfuscation VM decrypts to GARBAGE
    // instead of the real payload — the plaintext never materialises for a
    // hooked loadstring to capture. The JS twin assumes the 0-failure path, so
    // the legitimate round-trip is unchanged.
    L.push(`${v.xk}=${E.xorKey}+_E.math.floor(${v.fails}/${AT.SANDBOX_BOMB_THRESHOLD})*${keyGateMul}`);
    L.push(`do local _out={}`);
    L.push(`for _qi=1,#${v.fs} do`);
    L.push(`local _al=${v.bnd}(${v.xk},0xFFFF)`);
    L.push(`local _ah=${v.brs}(${v.xk},16)`);
    L.push(`${v.xk}=${v.bnd}(${v.bnd}(_al*1103515245+${v.bnd}(_ah*1103515245,0xFFFF)*0x10000,0xFFFFFFFF)+12345,0x7FFFFFFF)`);
    L.push(`_out[_qi]=${v.sc}(${v.bnd}(${v.bx}(${v.a}(${v.fs},_qi),${v.bnd}(${v.xk},0xFF)),0xFF))`);
    L.push(`end ${v.fs}=${v.cc}(_out) end`);

    // anti-tamper: opaque + decoys + payload hash + the retained hang bomb.
    // The sandbox detector already ran (above, to key-gate the cipher); here we
    // re-consume its cached failure count so a tripped sandbox ALSO hangs, not
    // just decrypts to garbage — defence in depth. Decoys are byte-identical to
    // the real bombs (same _E.game-gated task.wait(9e9)) but can never trip;
    // interleaving them means a reverser who neutralizes one hang-trigger can't
    // assume they've found the real one.
    for (const ln of AT.decoyGuards(v)) L.push(ln);
    for (const ln of AT.sandboxInvoke(v, v.fails)) L.push(ln);
    for (const ln of AT.opaqueGuard()) L.push(ln);
    for (const ln of AT.decoyGuards(v)) L.push(ln);
    for (const ln of AT.payloadHashGuard(v, E.payloadHash, E.payloadHashSeed)) L.push(ln);

    // load and run — reader-closure handoff (backlog #4: shrink capture window)
    // A dumper that hooks the string-loader and logs its argument — exactly how
    // the galactic-dumper dump lifted our plaintext `_fs` — receives a FUNCTION
    // here, not the payload string. `load(reader)` pulls the chunk in ~256-byte
    // pieces through a closure over string.sub, so the naive
    // `hook(loadstring, log_arg1)` grabs a closure it must now drive itself to
    // reassemble. We PREFER load's reader form when the env exposes `load`, and
    // ALWAYS fall back to the plain-string form (`loadstring`/`load`) when the
    // reader is absent or rejected (some executors' loader is string-only), so a
    // faithful executor ALWAYS runs — the round-trip is never gated on reader
    // support. On the fallback path a string-only hook still sees plaintext;
    // this narrows the common case without regressing compatibility.
    L.push(`${v.ok},${v.fn}=false,nil`);
    L.push(`if _E.load then`);
    L.push(`local _rp=1`);
    L.push(`local _rd=function() if _rp>#${v.fs} then return nil end local _re=_rp+255 local _rs=${v.sub}(${v.fs},_rp,_re) _rp=_re+1 return _rs end`);
    L.push(`${v.ok},${v.fn}=${v.p}(_E.load,_rd)`);
    L.push(`end`);
    L.push(`if not (${v.ok} and ${v.fn}) and ${v.ld} then ${v.ok},${v.fn}=${v.p}(${v.ld},${v.fs}) end`);
    L.push(`if ${v.ok} and ${v.fn} then`);
    L.push(`local _ok2,_res=${v.p}(${v.fn},...)`);
    L.push(`if not _ok2 then _E.error(${v.stR}(_res)) end`);
    L.push(`return _res`);
    L.push(`else _E.error("UmbraX: load failed") end`);

    L.push(`end)(getfenv and getfenv() or _ENV,unpack or table.unpack,select,...)`);

    let result = L.join(' ');
    result = result.replace(/\b_E\b/g, envP);
    result = result.replace(/\b_U\b/g, unpP);
    result = result.replace(/\b_S\b/g, selP);
    return result;
}

// ── JS twin of the emitted Lua decoder ───────────────────────────
// Re-implements, in JS, exactly what the generated Lua loader does at runtime
// (base64 → per-chunk xorshift → reassemble → reverse outer LCG-XOR). If this
// ever diverges from the emitted Lua, the round-trip breaks — so build() and
// this stay defined together, and verifyRoundTrip() proves they're inverses.
function _b64decToBytes(s, alpha) {
    const idx = {}; for (let i = 0; i < 64; i++) idx[alpha[i]] = i;
    const out = []; let acc = 0, bits = 0;
    for (const ch of s) {
        if (ch === '=') break;
        const val = idx[ch];
        if (val === undefined) continue;
        acc = acc * 64 + val; bits += 6;
        if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xFF); acc &= (1 << bits) - 1; }
    }
    return out;
}
function _twinDecode(E) {
    // reconstruct layer A
    const parts = [];
    for (let t = 1; t <= E.mapping.length; t++) {
        const pos = E.mapping[t - 1];
        const data = E.chunks[pos - 1];
        const encBytes = _b64decToBytes(data, E.alphabet);
        let st = (E.globalSeed ^ (t - 1)) >>> 0;
        for (const eb of encBytes) { st = xs32(st); parts.push((eb ^ (st & 0xFF)) & 0xFF); }
    }
    // reverse outer XOR
    let xk = E.xorKey;
    const out = [];
    for (let i = 0; i < parts.length; i++) { xk = lcgNext(xk); out.push((parts[i] ^ (xk & 0xFF)) & 0xFF); }
    return Buffer.from(out).toString('utf8');
}

/**
 * Encode `script`, then decode it with the JS twin of the emitted Lua loader,
 * and report whether the round-trip is exact. Mirrors engine.verifyRoundTrip so
 * the whole-script layer has the same fail-fast guarantee as the string cipher.
 */
function verifyRoundTrip(script) {
    const recovered = _twinDecode(encode(script));
    return { ok: recovered === script, original: script, recovered };
}

// ── JS-twin self-test: decode(encode(x)) === x ───────────────────
(function selfTest() {
    const samples = ['print("hi")', 'a'.repeat(2000), 'local x=1\nreturn x', '🔒 unicode ✓ test in script'];
    for (const s of samples) {
        if (!verifyRoundTrip(s).ok) throw new Error('[loader] self-test FAILED for ' + JSON.stringify(s.slice(0, 24)));
    }
})();

module.exports = { build, encode, verifyRoundTrip };
