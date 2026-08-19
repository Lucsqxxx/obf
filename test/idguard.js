// ═══════════════════════════════════════════════════════════════
//  UmbraX — Secure-loader cipher-twin suite
//
//  buildSecureLoader() ships an ENCRYPTED payload plus TWO Lua twins of the
//  JS keystream logic: __umx_h (djb2 seed) and __umx_ks (xorshift32 byte
//  stream). If either twin disagrees with the JS side by a single bit, a user
//  with the CORRECT script_id decrypts to GARBAGE and the script won't run —
//  the same JS/Lua-twin hazard class as the engine.js/loader.js LCG bug that
//  hid until it ran in a real VM.
//
//  This suite:
//    1. Extracts the ACTUAL __umx_h emitted by the loader and asserts it equals
//       JS idHash across ids (incl. the real UMBRX shape, unicode, edges).
//    2. Round-trips the WHOLE cipher: encrypt a payload in JS, then run the
//       emitted Lua (__umx_h + __umx_ks + the XOR-decrypt loop) in a fengari VM
//       with getgenv().script_id set, and assert the Lua reconstructs the exact
//       plaintext. Also asserts a WRONG script_id does NOT reconstruct it, and
//       that HWID binding works.
//
//  Run:  node test/idguard.js
// ═══════════════════════════════════════════════════════════════

'use strict';

const { lua, lauxlib, lualib, to_luastring } = require('fengari');
const {
    idHash, deriveSeed, encryptPayload, buildSecureLoader, NEUTRAL_HWID,
} = require('../src/bot/idguard');

// Lua 5.3 has no bit32; the polyfill mirrors the one used by the other suites.
const BIT32_POLYFILL = `
local function u32(x) return x & 0xFFFFFFFF end
bit32 = {
  band=function(a,b,...) local r=u32(a)&u32(b) for _,v in ipairs({...}) do r=r&u32(v) end return u32(r) end,
  bxor=function(a,b,...) local r=u32(a)~u32(b) for _,v in ipairs({...}) do r=r~u32(v) end return u32(r) end,
  lshift=function(a,n) if n>=32 or n<=-32 then return 0 end if n<0 then return u32(a)>>(-n) end return u32(u32(a)<<n) end,
  rshift=function(a,n) if n>=32 or n<=-32 then return 0 end if n<0 then return u32(u32(a)<<(-n)) end return u32(a)>>n end,
}
`;

// ── Extract an emitted Lua function body straight out of a real loader ──
// so this test breaks the moment a twin drifts from its JS counterpart.
// Captures from `local function <name>(` through its matching `    end` (the
// function is indented 4 spaces; its body is deeper, so the FIRST 4-space
// `end` closes it).
function extractFn(name) {
    const loader = buildSecureLoader('extract-probe', null, 'return 1');
    const start = loader.indexOf(`local function ${name}(`);
    if (start === -1) throw new Error(`could not find ${name} in emitted loader`);
    const rest = loader.slice(start);
    const m = /\n {4}end\b/.exec(rest);
    if (!m) throw new Error(`could not find end of ${name} in emitted loader`);
    return rest.slice(0, m.index + m[0].length);
}

const HASHER = extractFn('__umx_h');
const KSTREAM = extractFn('__umx_ks');

// ── Run a Lua program in a fresh VM, capturing a single print() string. ──
function runLua(program) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    let captured = null;
    lua.lua_pushjsfunction(L, (L) => {
        captured = lua.lua_tojsstring(L, 1);
        return 0;
    });
    lua.lua_setglobal(L, to_luastring('print'));
    const status = lauxlib.luaL_dostring(L, to_luastring(program));
    if (status !== lua.LUA_OK) return { ok: false, err: lua.lua_tojsstring(L, -1) };
    return { ok: true, value: captured };
}

// Build a Lua string literal from the UTF-8 bytes of `s`, escaping every byte
// as \ddd (matches idHash's UTF-8 iteration; independent of fengari encoding).
function luaBytes(s) {
    const bytes = Buffer.from(s, 'utf8');
    let lit = '"';
    for (const b of bytes) lit += `\\${b}`;
    return lit + '"';
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ════════════════════════════════════════════════════════════════
//  Part 1 — JS idHash ≡ emitted Lua __umx_h
// ════════════════════════════════════════════════════════════════
console.log('idguard part 1: JS idHash ≡ emitted Lua __umx_h (fengari)');

const u32 = (n) => n >>> 0;   // fengari prints low-32 SIGNED; real Luau is unsigned

function luaHash(input) {
    const program = `${BIT32_POLYFILL}\n${HASHER}\nprint(tostring(__umx_h(${luaBytes(input)})))`;
    const r = runLua(program);
    return r.ok ? { ok: true, value: u32(Number(r.value)) } : r;
}

const HASH_CASES = [
    'UMBRX-DEADBEEF-1337', 'UMBRX-00000000-0000', 'UMBRX-FFFFFFFF-FFFF',
    'a', 'ab', 'abc', 'hello world', 'x'.repeat(64), 'ünïcödé-ずんだ', '1234567890',
];
for (const input of HASH_CASES) {
    const jsVal = idHash(input);
    const luaRes = luaHash(input);
    if (!luaRes.ok) { ok(`hash("${input}")`, false, 'lua error: ' + luaRes.err); continue; }
    ok(`hash("${input.length > 24 ? input.slice(0, 24) + '…' : input}")`,
        luaRes.value === jsVal, luaRes.value === jsVal ? '' : `JS=${jsVal} Lua=${luaRes.value}`);
}

// ════════════════════════════════════════════════════════════════
//  Part 2 — full cipher round-trip: JS encrypt → emitted Lua decrypt
// ════════════════════════════════════════════════════════════════
console.log('\nidguard part 2: JS encrypt ≡ emitted Lua decrypt (fengari)');

// Decrypt `cipher` (Buffer) in Lua using the emitted __umx_h + __umx_ks and a
// seed derived from `scriptId`/`hwid`, exactly as the loader does at runtime.
// Returns the reconstructed string (or a lua error).
function luaDecrypt(cipher, scriptId, hwid) {
    const dataLit = '"' + [...cipher].map(b => `\\${b}`).join('') + '"';
    const hwidExpr = hwid !== null ? `__umx_h(${luaBytes(hwid)})` : String(NEUTRAL_HWID);
    const program = [
        BIT32_POLYFILL,
        HASHER,
        KSTREAM,
        // Emit the plaintext back out via print, byte-escaped so the harness
        // gets the exact bytes regardless of fengari string handling.
        `local idh = __umx_h(${luaBytes(scriptId)})`,
        `local hwidh = ${hwidExpr}`,
        `local seed = bit32.bxor(idh, hwidh)`,
        `local data = ${dataLit}`,
        `local n = #data`,
        `local key = __umx_ks(seed, n)`,
        `local out = {}`,
        `for i = 1, n do out[i] = string.char(bit32.bxor(string.byte(data, i), key[i])) end`,
        // Print each byte value comma-joined so we compare exact bytes.
        `local bytes = {}`,
        `for i = 1, n do bytes[i] = tostring(string.byte(out[i])) end`,
        `print(table.concat(bytes, ","))`,
    ].join('\n');
    const r = runLua(program);
    if (!r.ok) return r;
    const bytes = r.value ? r.value.split(',').map(Number) : [];
    return { ok: true, value: Buffer.from(bytes).toString('utf8') };
}

const PAYLOADS = [
    'print("hi")',
    'local x = 1 + 2\nprint(x)\nreturn x',
    'getgenv().flag = true\nprint("exploit")',
    'print("ünïcödé ずんだ 🎉")',   // multibyte payload
    'return (function() for i=1,3 do print(i) end end)()',
];

for (const payload of PAYLOADS) {
    const id = 'UMBRX-ABCD1234-5678';
    const ct = encryptPayload(id, null, payload);
    const dec = luaDecrypt(ct, id, null);
    const label = payload.length > 28 ? payload.slice(0, 28).replace(/\n/g, '⏎') + '…' : payload.replace(/\n/g, '⏎');
    if (!dec.ok) { ok(`decrypt "${label}"`, false, 'lua error: ' + dec.err); continue; }
    ok(`correct id decrypts "${label}"`, dec.value === payload, dec.value === payload ? '' : `got ${JSON.stringify(dec.value.slice(0, 40))}`);
}

// Wrong credential must NOT reconstruct the payload.
{
    const id = 'UMBRX-11112222-3333', wrong = 'UMBRX-99998888-7777';
    const payload = 'print("secret")';
    const ct = encryptPayload(id, null, payload);
    const dec = luaDecrypt(ct, wrong, null);
    ok('wrong id does NOT decrypt', dec.ok && dec.value !== payload, dec.ok ? `unexpectedly got ${JSON.stringify(dec.value)}` : 'lua error: ' + dec.err);
}

// HWID-bound: correct id + correct hwid decrypts; correct id + wrong hwid does not.
{
    const id = 'UMBRX-CAFEBABE-9001', hwid = 'HWID-abcdef';
    const payload = 'print("hwid-locked")\nreturn 7';
    const ct = encryptPayload(id, hwid, payload);
    const good = luaDecrypt(ct, id, hwid);
    ok('hwid: correct id+hwid decrypts', good.ok && good.value === payload, good.ok ? `got ${JSON.stringify(good.value.slice(0, 40))}` : good.err);
    const badHwid = luaDecrypt(ct, id, 'HWID-wrong');
    ok('hwid: wrong hwid does NOT decrypt', badHwid.ok && badHwid.value !== payload, badHwid.ok ? 'unexpectedly matched' : badHwid.err);
}

// ════════════════════════════════════════════════════════════════
//  Part 3 — structural sanity on the emitted loader
// ════════════════════════════════════════════════════════════════
console.log('\nidguard part 3: emitted loader structure');
{
    const loader = buildSecureLoader('UMBRX-STRUCT-0001', null, 'print("x")');
    ok('no lethal task.wait(9e9) hang in loader', !/task\.wait\(9e9\)/.test(loader));
    ok('loader decrypts+runs via loadstring/load', /\(loadstring or load\)/.test(loader));
    ok('no plaintext credential baked in', !loader.includes('UMBRX-STRUCT-0001'));
    // deriveSeed sanity: id xor NEUTRAL_HWID when no hwid.
    ok('deriveSeed(no-hwid) = idHash ^ NEUTRAL', deriveSeed('abc', null) === ((idHash('abc') ^ NEUTRAL_HWID) >>> 0));
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
process.exit(fail ? 1 : 0);
