// ═══════════════════════════════════════════════════════════════
//  UmbraX — .secure credential lock (cipher-gated loader)
//
//  Builds the client-side credential gate that wraps a .secure payload.
//
//  DESIGN — why this is stronger than a boolean check:
//    The old guard was `if hash(script_id) ~= EXPECTED then hang`. Anyone
//    with the deobfuscated source could delete that one `if` and run the
//    script with no credential at all. There was nothing structurally tying
//    the payload to the credential.
//
//    This version makes the credential the DECRYPTION KEY. The real payload
//    ships ENCRYPTED with a keystream derived from `script_id` (+ optional
//    HWID). At runtime the loader re-derives the same keystream from
//    getgenv().script_id and decrypts. There is no branch to strip: a wrong
//    or missing credential yields garbage bytes that simply fail `loadstring`.
//    The key itself never appears in the file — only someone who supplies the
//    correct script_id can reconstruct the plaintext.
//
//  STILL client-side deterrence, not absolute security: a legitimate user
//  (who by definition has the correct id) can dump the decrypted source. For a
//  hard lock, gate delivery server-side. But the "just delete the check"
//  bypass is gone — decryption structurally requires the credential.
//
//  DOUBLE-SAFE / TWIN HAZARD: the JS keystream and the emitted Lua keystream
//  are TWINS — they must produce bit-identical bytes or a user with the
//  CORRECT id gets garbage. Both sides use only 32-bit ops (djb2 + xorshift32
//  via bit32), which stay exact in Luau's doubles. Pinned by test/idguard.js
//  (extracts the emitted Lua and round-trips a real encrypt/decrypt in a VM).
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

// Neutral HWID hash used when no HWID binding is requested — both JS and the
// emitted Lua substitute this same constant so the seed is well-defined.
const NEUTRAL_HWID = 5381;   // djb2 init; arbitrary shared constant

// djb2 over the UTF-8 BYTES of `s` (matches the emitted Lua __umx_h, which
// uses string.byte). Iterating bytes keeps the twins bit-identical for
// non-ASCII ids/HWIDs too. Returns an unsigned 32-bit int. See test/idguard.js.
function idHash(s) {
    const bytes = Buffer.from(String(s), 'utf8');
    let h = 5381;
    for (let i = 0; i < bytes.length; i++) h = (((h << 5) >>> 0) + h + bytes[i]) >>> 0;
    return h;
}

// Combine the id hash and (optional) hwid hash into a single 32-bit seed. When
// no HWID is bound, NEUTRAL_HWID stands in for the hwid hash on BOTH sides.
function deriveSeed(scriptId, hwid) {
    const idH   = idHash(scriptId);
    const hwidH = hwid ? idHash(hwid) : NEUTRAL_HWID;
    return (idH ^ hwidH) >>> 0;
}

// xorshift32 keystream — `n` bytes derived from `seed`. Bit-for-bit twin of the
// emitted Lua __umx_ks (each step normalised to uint32, matching bit32). A zero
// seed is bumped to 1 (xorshift is stuck at 0) — the Lua side does the same.
function keystream(seed, n) {
    let x = seed >>> 0;
    if (x === 0) x = 1;
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
        x = (x ^ (x << 13)) >>> 0;
        x = (x ^ (x >>> 17)) >>> 0;
        x = (x ^ (x << 5)) >>> 0;
        out[i] = x & 0xFF;
    }
    return out;
}

// Encrypt `payload` (a string) under the credential-derived keystream. Returns
// a Buffer of ciphertext bytes (same length as the UTF-8 payload).
function encryptPayload(scriptId, hwid, payload) {
    const data = Buffer.from(String(payload), 'utf8');
    const key  = keystream(deriveSeed(scriptId, hwid), data.length);
    const out  = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i];
    return out;
}

// Escape a byte buffer as a Lua string literal using a \ddd decimal escape for
// EVERY byte. Escaping all bytes (not just special ones) means no literal digit
// can ever follow an escape, so the escapes are always unambiguous, and quotes/
// newlines/backslashes in the ciphertext can't break out of the literal.
function luaByteLiteral(buf) {
    let s = '"';
    for (const b of buf) s += '\\' + b;
    return s + '"';
}

// Build the full self-decrypting loader Lua for a .secure payload. `payload`
// is the (already-obfuscated) script; the returned Lua embeds it as ciphertext
// and only decrypts+runs it when getgenv().script_id (+ HWID) reproduces the
// key. There is deliberately NO lethal branch — a wrong credential just fails
// to decrypt into valid Lua and the loader exits quietly.
function buildSecureLoader(scriptId, hwid, payload) {
    const cipher  = encryptPayload(scriptId, hwid, payload);
    const dataLit = luaByteLiteral(cipher);

    // When HWID-bound, re-derive the hwid hash at runtime; otherwise splice in
    // the same NEUTRAL_HWID constant the JS deriveSeed used.
    const hwidBind = hwid
        ? [
            `    local __umx_hwid = (gethwid and gethwid()) or (__umx_genv and __umx_genv.hwid) or nil`,
            `    local __umx_hwidh = __umx_h(__umx_hwid)`,
          ].join('\n')
        : `    local __umx_hwidh = ${NEUTRAL_HWID}`;

    return [
        `-- UmbraX Secure Loader`,
        `do`,
        `    local __umx_genv = (typeof(getgenv) == "function") and getgenv() or nil`,
        `    local function __umx_h(s)`,
        `        if type(s) ~= "string" then return -1 end`,
        `        local h = 5381`,
        `        for i = 1, #s do h = bit32.band((bit32.lshift(h,5) + h + string.byte(s,i)), 0xFFFFFFFF) end`,
        `        return h`,
        `    end`,
        `    local function __umx_ks(seed, n)`,
        `        local x = bit32.band(seed, 0xFFFFFFFF)`,
        `        if x == 0 then x = 1 end`,
        `        local out = {}`,
        `        for i = 1, n do`,
        `            x = bit32.bxor(x, bit32.lshift(x, 13))`,
        `            x = bit32.bxor(x, bit32.rshift(x, 17))`,
        `            x = bit32.bxor(x, bit32.lshift(x, 5))`,
        `            out[i] = bit32.band(x, 0xFF)`,
        `        end`,
        `        return out`,
        `    end`,
        `    local __umx_idh = __umx_h(__umx_genv and __umx_genv.script_id or nil)`,
        hwidBind,
        `    local __umx_seed = bit32.bxor(__umx_idh, __umx_hwidh)`,
        `    local __umx_data = ${dataLit}`,
        `    local __umx_n = #__umx_data`,
        `    local __umx_key = __umx_ks(__umx_seed, __umx_n)`,
        `    local __umx_out = {}`,
        `    for i = 1, __umx_n do`,
        `        __umx_out[i] = string.char(bit32.bxor(string.byte(__umx_data, i), __umx_key[i]))`,
        `    end`,
        `    local __umx_fn = (loadstring or load)(table.concat(__umx_out))`,
        `    if __umx_fn then`,
        `        return __umx_fn()`,
        `    elseif typeof(warn) == "function" then`,
        `        warn("[UmbraX] Invalid or missing script credentials. This script is locked.")`,
        `    end`,
        `end`,
        ``,
    ].join('\n');
}

module.exports = { idHash, deriveSeed, keystream, encryptPayload, buildSecureLoader, NEUTRAL_HWID };
