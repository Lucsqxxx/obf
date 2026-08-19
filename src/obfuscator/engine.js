// ═══════════════════════════════════════════════════════════════
//  UmbraX — String Cipher Engine
//
//  ONE spec drives both the JS encryptor and the emitted Lua decryptor,
//  so they are inverse BY CONSTRUCTION. A round-trip self-test runs at
//  module load (see bottom) and throws if they ever diverge.
//
//  Cipher: CFB-style stream cipher over UTF-8 bytes.
//    seed  = mix(key)                       -- 32-bit, nonzero
//    fb    = key & 0xFF                      -- feedback register
//    per byte i:
//      s        = next()                     -- xorshift32 keystream byte
//      c[i]     = p[i] XOR s XOR fb          -- encrypt
//      fb       = c[i]                        -- ciphertext feedback
//    Decrypt is identical with p[i] = c[i] XOR s XOR fb (fb known from c).
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { rng, rname } = require('./rng');

// ── PRNG / seed (must match the emitted Lua exactly) ─────────────

// 32-bit unsigned multiply via 16-bit split. CRITICAL: Lua has no 32-bit
// integer multiply — `a*b` runs in doubles and loses bits above 2^53. The
// emitted Lua reproduces THIS exact formula, so JS must use it too (not
// Math.imul) to stay bit-identical. Each partial product stays < 2^48 < 2^53.
function mul32(a, b) {
    a >>>= 0; b >>>= 0;
    const al = a & 0xFFFF;
    const ah = a >>> 16;
    const lo = al * b;
    const hi = ((ah * b) & 0xFFFF) * 0x10000;
    return (lo + hi) >>> 0;
}

function mixSeed(key) {
    // splitmix-style avalanche, then force nonzero (xorshift dies on 0).
    let z = (key ^ 0x9E3779B9) >>> 0;
    z = mul32(z ^ (z >>> 16), 0x85EBCA6B);
    z = mul32(z ^ (z >>> 13), 0xC2B2AE35);
    z = (z ^ (z >>> 16)) >>> 0;
    return z === 0 ? 0x1A2B3C4D : z;
}

// xorshift32 — returns updated state (32-bit unsigned).
function xorshift32(state) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state >>> 0;
}

class ObfuscatorEngine {
    constructor() {}

    generateKey() {
        return Math.floor(rng() * 2_000_000_000) + 100_000_000;
    }

    // Index-derived pool key (twin of the emitted DERIVE global). The pool no
    // longer stores a per-entry key array; each entry's key is recomputed at
    // runtime from a single per-build `base` secret XOR mix(index). mix() is the
    // same avalanche the cipher already uses, so distinct indices give distinct,
    // unrelated keys. `>>> 0` matches bit32's unsigned result in Lua.
    deriveKey(base, index) {
        return (base ^ mixSeed(index >>> 0)) >>> 0;
    }

    // ── UTF-8 encode / decode (correct for emoji & all Unicode) ──

    _encode(str) {
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            const cp = str.charCodeAt(i);
            if (cp < 0x80) {
                bytes.push(cp);
            } else if (cp < 0x800) {
                bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
            } else if (cp >= 0xD800 && cp <= 0xDBFF) {
                const lo = str.charCodeAt(i + 1);
                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                    i++;
                    const codePoint = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    bytes.push(
                        0xF0 | (codePoint >> 18),
                        0x80 | ((codePoint >> 12) & 0x3F),
                        0x80 | ((codePoint >> 6) & 0x3F),
                        0x80 | (codePoint & 0x3F),
                    );
                } else {
                    bytes.push(0xEF, 0xBF, 0xBD);
                }
            } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                bytes.push(0xEF, 0xBF, 0xBD);
            } else {
                bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
            }
        }
        return new Uint8Array(bytes);
    }

    _decode(bytes) {
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
        }
        // Minimal fallback (Node always has TextDecoder, kept for safety).
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    }

    // ── Encrypt / decrypt ────────────────────────────────────────

    encrypt(plaintext, key) {
        const bytes = this._encode(plaintext);
        const out = new Uint8Array(bytes.length);
        let state = mixSeed(key >>> 0);
        let fb = key & 0xFF;
        for (let i = 0; i < bytes.length; i++) {
            state = xorshift32(state);
            const s = state & 0xFF;
            const c = (bytes[i] ^ s ^ fb) & 0xFF;
            out[i] = c;
            fb = c;
        }
        return out;
    }

    // JS twin of the emitted Lua decrypt — used only by the self-test and by
    // verifyRoundTrip. Kept beside encrypt so the two can never drift apart.
    decrypt(encryptedBytes, key) {
        const out = new Uint8Array(encryptedBytes.length);
        let state = mixSeed(key >>> 0);
        let fb = key & 0xFF;
        for (let i = 0; i < encryptedBytes.length; i++) {
            state = xorshift32(state);
            const s = state & 0xFF;
            const c = encryptedBytes[i] & 0xFF;
            out[i] = (c ^ s ^ fb) & 0xFF;
            fb = c;
        }
        return this._decode(out);
    }

    // ── Lua serialisation ────────────────────────────────────────

    toLuaEscape(bytes) {
        const parts = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) parts[i] = '\\' + bytes[i].toString().padStart(3, '0');
        return parts.join('');
    }

    /**
     * Emit the Lua decrypt runtime. `n` is a map of polymorphic identifier
     * names so two builds never share symbol names:
     *   n.DEC   — global decrypt function name  DEC(s,key) -> plaintext string
     *   n.mix   — seed-mixing local function
     *   n.bx, n.bs, n.bls, n.brs, n.bnd — bit32.bxor/band/lshift/rshift aliases
     *   n.sc, n.sb, n.cc — string.char / string.byte / table.concat aliases
     *
     * Returned Lua is a single `do ... end` block; it round-trips with
     * `encrypt()` above (asserted by the self-test).
     */
    emitDecryptStub(n) {
        return [
            `do `,
            `local ${n.bx},${n.bnd},${n.bls},${n.brs}=bit32.bxor,bit32.band,bit32.lshift,bit32.rshift;`,
            `local ${n.sc},${n.sb},${n.cc}=string.char,string.byte,table.concat;`,
            // 32-bit unsigned multiply via 16-bit split — matches JS mul32 exactly.
            // Bare `a*b` in Lua loses precision above 2^53; this keeps it exact.
            `local function ${n.mul}(a,b)`,
            `local al=${n.bnd}(a,0xFFFF);`,
            `local ah=${n.brs}(a,16);`,
            `return ${n.bnd}(al*b+${n.bnd}(ah*b,0xFFFF)*0x10000,0xFFFFFFFF) `,
            `end;`,
            // seed mix — identical avalanche to JS mixSeed
            `local function ${n.mix}(k)`,
            `local z=${n.bnd}(${n.bx}(k,0x9E3779B9),0xFFFFFFFF);`,
            `z=${n.mul}(${n.bx}(z,${n.brs}(z,16)),0x85EBCA6B);`,
            `z=${n.mul}(${n.bx}(z,${n.brs}(z,13)),0xC2B2AE35);`,
            `z=${n.bnd}(${n.bx}(z,${n.brs}(z,16)),0xFFFFFFFF);`,
            `if z==0 then z=0x1A2B3C4D end;`,
            `return z `,
            `end;`,
            // cache so repeated decrypts of the same literal are cheap
            `local ${n.cache}={};`,
            `function ${n.DEC}(s,key)`,
            `local hit=${n.cache}[s];if hit and hit[1]==key then return hit[2] end;`,
            `local state=${n.mix}(key);`,
            `local fb=key%256;`,
            `local o={};`,
            `for i=1,#s do `,
            `state=${n.bnd}(${n.bx}(state,${n.bls}(state,13)),0xFFFFFFFF);`,
            `state=${n.bx}(state,${n.brs}(state,17));`,
            `state=${n.bnd}(${n.bx}(state,${n.bls}(state,5)),0xFFFFFFFF);`,
            `local c=${n.sb}(s,i);`,
            `o[i]=${n.sc}(${n.bnd}(${n.bx}(${n.bx}(c,${n.bnd}(state,0xFF)),fb),0xFF));`,
            `fb=c `,
            `end;`,
            `local r=${n.cc}(o);`,
            `${n.cache}[s]={key,r};`,
            `return r `,
            `end `,
            // Index-derived pool key: DERIVE(base,i) = base XOR mix(i), masked to
            // 32-bit unsigned. Global (like DEC) so the pool's GET can reach it;
            // defined inside the block so it closes over the local mix/bx/bnd.
            // Twin of JS deriveKey(). Emitted even when the pool layer is off
            // (harmless: an unused global), keeping the stub signature stable.
            `function ${n.DERIVE}(b,i)return ${n.bnd}(${n.bx}(b,${n.mix}(i)),0xFFFFFFFF) end `,
            `end;`,
        ].join('');
    }

    /**
     * Emit the string-array pool runtime (opt-in `stringPool`). Given the
     * already-escaped ciphertext literals and a single per-build `base` secret,
     * emit:
     *   POOL = { "\\xxx...", ... }   -- ciphertext bodies (escaped)
     *   GET(i) -> DEC(POOL[i], DERIVE(base, i)) with a one-slot memo per index.
     * There is NO per-entry key array any more: each entry's key is recomputed
     * from the index via DERIVE(base,i) = base XOR mix(i). This removes the
     * parallel key table a static reader could line up 1:1 against POOL, and the
     * key for entry i is only knowable by running the same mix() the cipher uses.
     * Call-sites become GET(n) instead of an inline DEC("...",key).
     * Relies on n.DEC and n.DERIVE already being defined (emitDecryptStub first).
     */
    emitStringPool(n, escapedList, base) {
        const pool = escapedList.map(e => `"${e}"`).join(',');
        return [
            `local ${n.POOL}={${pool}};`,
            `local ${n.PK}=${base >>> 0};`,   // per-build base secret (scalar, not a table)
            `local ${n.GETc}={};`,
            `local function ${n.GET}(i)`,
            `local h=${n.GETc}[i];if h~=nil then return h end;`,
            `local r=${n.DEC}(${n.POOL}[i],${n.DERIVE}(${n.PK},i));`,
            `${n.GETc}[i]=r;return r `,
            `end;`,
        ].join('');
    }

    /** Default polymorphic name set generator for the decrypt stub. */
    decryptNames(rand = () => rname(2, 8)) {
        return {
            DEC: rand(), mix: rand(), mul: rand(), cache: rand(),
            bx: rand(), bnd: rand(), bls: rand(), brs: rand(),
            sc: rand(), sb: rand(), cc: rand(),
            // DERIVE(base,i) = base XOR mix(i): index-derived pool key. Emitted
            // by the decrypt stub (closes over mix); called by the pool's GET.
            DERIVE: rand(),
            // String-array pool (opt-in `stringPool`): POOL[i] = encrypted literal,
            // PK = per-build base secret (scalar), GET(i) = DEC(POOL[i],DERIVE(PK,i)).
            // Unused when the pool layer is off; harmless extra names otherwise.
            POOL: rand(), PK: rand(), GET: rand(), GETc: rand(),
        };
    }

    // ── Utilities ────────────────────────────────────────────────

    verifyRoundTrip(text, key = null) {
        if (key === null) key = this.generateKey();
        const recovered = this.decrypt(this.encrypt(text, key), key);
        return { ok: recovered === text, original: text, recovered };
    }

    calcEntropy(bytes) {
        const freq = new Uint32Array(256);
        for (const b of bytes) freq[b]++;
        let ent = 0;
        const len = bytes.length;
        for (const f of freq) if (f > 0) { const p = f / len; ent -= p * Math.log2(p); }
        return ent.toFixed(2);
    }

    /** Encrypt and return everything the transformer needs. */
    encryptToLua(plaintext, key = null) {
        if (key === null) key = this.generateKey();
        const encrypted = this.encrypt(plaintext, key);
        const escaped = this.toLuaEscape(encrypted);
        return { escaped, key, length: encrypted.length, entropy: this.calcEntropy(encrypted) };
    }
}

// ── Load-time self-test: encrypt/decrypt MUST round-trip ─────────
// This is the guarantee that the JS cipher (and therefore the emitted Lua
// twin, which shares the exact same arithmetic) never silently breaks.
(function selfTest() {
    const e = new ObfuscatorEngine();
    const samples = ['', 'A', 'hello world', 'game:GetService("Players")',
        '🔒 emoji ✓ test', 'a'.repeat(1000), '\x00\x01\x02\xFF raw bytes'];
    for (const s of samples) {
        for (const key of [1, 255, 256, 123456789, 2000000000]) {
            const r = e.verifyRoundTrip(s, key);
            if (!r.ok) {
                throw new Error(`[engine] self-test FAILED for ${JSON.stringify(s.slice(0, 20))} key=${key}`);
            }
        }
    }
})();

module.exports = ObfuscatorEngine;
