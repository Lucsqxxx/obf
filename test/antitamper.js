// ═══════════════════════════════════════════════════════════════
//  UmbraX — Anti-Tamper behavioural test (SMART-LETHAL contract)
//
//  The traps are anti-DEOBFUSCATION: on a strong instrumentation/tamper
//  signal the script hangs forever (`task.wait(9e9)`), so a naive automated
//  deobfuscator that runs the loader in an emulated/hooked VM wedges instead
//  of dumping the payload. But a lethal trap is only acceptable if it can tell
//  a deobfuscator apart from a normal user — otherwise it bricks real users
//  (which the old hook-count bomb did). So this suite asserts BOTH directions:
//
//    1. FAITHFUL EXECUTOR (game present, APIs behave) → runs to completion.
//       No trap may fire on a real user. Also checks the non-lethal hook sink
//       still executed (checks aren't dead-code-eliminated).
//    2. INSTRUMENTED SANDBOX (fake DataModel answering everything, hooked
//       loadstring, slow clock, wrong debug types) → HANGS. The sandbox suite
//       crosses its failure threshold and the bomb fires. Proves real teeth.
//    3. TAMPERED PAYLOAD (payload bytes patched after build) → HANGS. The
//       djb2 payload-hash bomb fires.
//    4. CLEAN OFFLINE (no game) → runs to completion (bombs are game-gated).
//
//  `task.wait` throws a sentinel so a fired bomb surfaces as an error we can
//  assert on, instead of hanging the test process.
//
//  Run:  node test/antitamper.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const { lua, lauxlib, lualib, to_luastring } = require('fengari');
const loader = require('../src/obfuscator/loader');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const SENTINEL = '__UMBRAX_BOMB__';

// bit32 polyfill (fengari is 5.3) — same as lua-runtime.js.
const BIT32 = `
local function u32(x) return x & 0xFFFFFFFF end
bit32 = {
  band=function(a,b,...) local r=u32(a)&u32(b) for _,v in ipairs({...}) do r=r&u32(v) end return u32(r) end,
  bor=function(a,b,...) local r=u32(a)|u32(b) for _,v in ipairs({...}) do r=r|u32(v) end return u32(r) end,
  bxor=function(a,b,...) local r=u32(a)~u32(b) for _,v in ipairs({...}) do r=r~u32(v) end return u32(r) end,
  bnot=function(a) return u32(~u32(a)) end,
  lshift=function(a,n) if n>=32 or n<=-32 then return 0 end if n<0 then return u32(a)>>(-n) end return u32(u32(a)<<n) end,
  rshift=function(a,n) if n>=32 or n<=-32 then return 0 end if n<0 then return u32(u32(a)<<(-n)) end return u32(a)>>n end,
  lrotate=function(a,n) n=n%32 a=u32(a) return u32((a<<n)|(a>>(32-n))) end,
}
loadstring = load
unpack = table.unpack
`;

// The sentinel-throwing task, shared by every env: any fired bomb calls
// task.wait(9e9), which errors with SENTINEL instead of hanging the test.
const TASK = `task = { wait = function(n) error("${SENTINEL}") end, spawn=function(f) if type(f)~="function" then error("spawn") end end, defer=function() end }\n`;

// ── (1) FAITHFUL EXECUTOR — behaves like a real one; no trap should fire ──
const FAITHFUL = TASK + `
local function inst(name, class)
  local children = {}
  return setmetatable({ Name = name, ClassName = class or "Instance" }, {
    __index = function(self, k)
      if k == "FindFirstChild" then return function(_, n) return children[n] end end
      if k == "FindFirstChildOfClass" then return function() return nil end end
      if k == "GetChildren" then return function() local t={} for _,c in pairs(children) do t[#t+1]=c end return t end end
      if k == "GetService" then return function(_, n) children[n] = children[n] or inst(n) return children[n] end end
      if k == "Destroy" then return function() end end
      return nil
    end,
  })
end
game = inst("game", "DataModel")
workspace = inst("Workspace", "Workspace")
Instance = { new = function(c) return inst("New", c) end }
newproxy = function() return setmetatable({}, {}) end
os = os or { clock = function() return 0 end }
hookfunction=function(a) return a end
hookmetamethod=function() return function() end end
getrawmetatable=function(o) return getmetatable(o) or {} end
getnamecallmethod=function() return "GetService" end
setreadonly=function() end
checkcaller=function() return true end
iscclosure=function() return false end
_G.__umx_genv = {}
getgenv=function() return _G.__umx_genv end
`;

// ── (2) INSTRUMENTED SANDBOX — what a naive deobfuscator VM looks like ──
// A fake DataModel that answers ANY method truthily (so the "call a method
// that shouldn't exist" probes wrongly succeed), a hooked loadstring whose
// error line numbers don't advance, a single-stepped slow clock, and wrong
// debug.* return types. This trips many sandbox probes at once.
const INSTRUMENTED = TASK + `
local anymt = { __index = function() return function() return {} end end }
game = setmetatable({}, anymt)
workspace = setmetatable({}, anymt)
Instance = { new = function() return setmetatable({}, anymt) end }
newproxy = function() return setmetatable({}, {}) end
loadstring = function(s) return load((s:gsub("^\\n", ""))) end
os = { clock = (function() local t=0 return function() t=t+5 return t end end)() }
debug = { info = function() return 123 end, getinfo = function() return nil end, traceback = function() return 42 end }
rawequal = function() return false end
hookfunction=function(a) return a end
hookmetamethod=function() return function() end end
getrawmetatable=function() return {} end
getnamecallmethod=function() return "X" end
setreadonly=function() end
checkcaller=function() return true end
iscclosure=function() return false end
_G.__umx_genv = {}
getgenv=function() return _G.__umx_genv end
`;

// ── (4) CLEAN OFFLINE — no game; every bomb is game-gated ──
const CLEAN_ENV = TASK;

// Run `luaSource` under `envPrelude`. The wrapped loader's top-level statement
// is `return ...`, so we can't append after it — run it via load([==[ ]==])
// (the loader delimits its own data with [=[ ]=], so two '=' is safe) and
// discard the result, letting execution continue to the flag probe.
// Returns { ok, err, flagged, bombed }.
// The non-lethal hook sink writes its verdict to getgenv()[<flagKey>]. That key
// is now RANDOMIZED per build (it used to be the static, greppable "_umx_flag"),
// so we recover the actual key from the emitted source instead of hardcoding it.
// The hook sink is the ONLY writer using the local `_gv` (see sinkStmt); the
// sandbox probes use `_genv`. So `_gv["<key>"]=` uniquely identifies it.
function hookFlagKey(luaSource) {
    const m = /_gv\[("(?:[^"\\]|\\.)*")\]=/.exec(luaSource);
    if (!m) throw new Error('could not locate hook-sink flag key in emitted loader');
    return JSON.parse(m[1]);
}

function runWithEnv(envPrelude, luaSource) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    lua.lua_pushjsfunction(L, () => 0); // silence print
    lua.lua_setglobal(L, to_luastring('print'));
    // KEY PRESENCE, not truthiness: guards run in sequence and each non-lethal
    // sink overwrites the flag key, so a non-nil value proves ≥1 sink executed.
    const flagKey = hookFlagKey(luaSource);
    const probe = `\n_G.__umx_flag_set = (getgenv and type(getgenv())=="table" and getgenv()[${JSON.stringify(flagKey)}]~=nil) or false\n`;
    const runner = `local _r=assert(load([==[\n${luaSource}\n]==])) _r()\n`;
    const full = BIT32 + '\n' + envPrelude + '\n' + runner + probe;
    const status = lauxlib.luaL_dostring(L, to_luastring(full));
    if (status !== lua.LUA_OK) {
        const err = lua.lua_tojsstring(L, -1);
        return { ok: false, err, flagged: false, bombed: String(err).includes(SENTINEL) };
    }
    lua.lua_getglobal(L, to_luastring('__umx_flag_set'));
    const flagged = lua.lua_toboolean(L, -1);
    lua.lua_pop(L, 1);
    return { ok: true, err: null, flagged, bombed: false };
}

// Patch payload bytes inside the loader's data table so the reconstructed
// payload no longer matches its recorded djb2 hash — simulates a deobfuscator
// that edited the encrypted body. The loader mixes REAL chunks with decoys and
// shuffles them, so flipping one arbitrary [=[...]=] literal might only hit a
// decoy (never decoded). To reliably alter a real chunk, mutate the FIRST
// char of EVERY data literal — at least one is real and feeds the layer-A
// reconstruction the hash covers.
function tamperPayload(wrapped) {
    return wrapped.replace(/\[=\[(.)/g, (m, c) => '[=[' + (c === 'A' ? 'B' : 'A'));
}

console.log('anti-tamper: smart-lethal (traps a deobfuscator, spares real users)');

// (1) Faithful executor: runs clean, and the non-lethal hook sink still ran.
for (let i = 0; i < 5; i++) {
    const r = runWithEnv(FAITHFUL, loader.build('return 1', false));
    ok(`build #${i + 1}: faithful executor runs to completion`,
        r.ok && !r.bombed, r.ok ? '' : 'errored: ' + r.err);
    ok(`build #${i + 1}: non-lethal hook sink ran (flag set)`,
        r.flagged, 'sink did not write _umx_flag — checks may be dead-code-eliminated');
}

// (2) Instrumented deobfuscation sandbox: a bomb MUST fire (sentinel raised).
for (let i = 0; i < 5; i++) {
    const r = runWithEnv(INSTRUMENTED, loader.build('return 1', false));
    ok(`build #${i + 1}: instrumented sandbox is trapped (hangs)`,
        r.bombed, r.bombed ? '' : (r.ok ? 'ran to completion — trap did NOT fire' : 'errored without bomb: ' + r.err));
}

// (3) Tampered payload: the djb2 hash bomb MUST fire, even in a faithful env.
for (let i = 0; i < 5; i++) {
    const r = runWithEnv(FAITHFUL, tamperPayload(loader.build('return 1', false)));
    ok(`build #${i + 1}: patched payload is trapped (hangs)`,
        r.bombed, r.bombed ? '' : (r.ok ? 'ran to completion — hash bomb did NOT fire' : 'errored without bomb: ' + r.err));
}

// (4) Clean offline (no game): runs to completion; bombs are game-gated.
{
    const r = runWithEnv(CLEAN_ENV, loader.build('return 1', false));
    ok('clean offline env (no game) runs to completion',
        r.ok && !r.bombed, r.ok ? '' : 'errored: ' + r.err);
}

console.log(`\n${'═'.repeat(46)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
