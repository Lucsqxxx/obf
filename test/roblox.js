// ═══════════════════════════════════════════════════════════════
//  UmbraX — Real-executor runtime suite
//
//  The other suites (test/run.js, zluau.js) deliberately leave `game`
//  NIL, and every anti-tamper guard was written to be inert when `game`
//  is nil — so they only ever exercised the ONE environment where the
//  guards can't fire. That hid a fatal bug: in a real Roblox exploit
//  executor (where `game` exists AND executor globals like hookfunction /
//  getrawmetatable are present) the old anti-tamper "bomb" entered an
//  infinite `task.wait(9e9)` and the script hung forever.
//
//  This suite runs the obfuscated output in a fengari VM whose prelude
//  DEFINES a Roblox-executor environment: `game`, `workspace`, `task`,
//  `Instance`, and the full executor-global surface. `task.wait` is rigged
//  to THROW a sentinel, so any surviving hang fails fast (rather than
//  wedging CI). Each script must run and print byte-identical output to
//  the un-obfuscated original.
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { lua, lauxlib, lualib, to_luastring } = require('fengari');
const Transformer = require('../src/obfuscator/transformer');

// Lua 5.3 polyfill (bit32/loadstring/unpack) + a Roblox exploit-executor shim.
// Everything a real executor exposes is present, including `game`/`workspace`
// (so anti-tamper is ACTIVE) and `task.wait` wired to throw a sentinel so a
// surviving bomb surfaces as a test failure instead of an infinite hang.
const PRELUDE = `
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

-- ===== Roblox exploit-executor environment =====
-- Hook/closure globals — >=5 present is what the old hook bomb tripped on.
hookfunction=function(a,b) return a end
hookmetamethod=function() return function() end end
getrawmetatable=function(o) return getmetatable(o) or {} end
getnamecallmethod=function() return "GetService" end
setreadonly=function(t) return t end
checkcaller=function() return true end
iscclosure=function() return false end
islclosure=function() return true end
newcclosure=function(f) return f end
getgenv=function() _G.__genv = _G.__genv or {} return _G.__genv end
identifyexecutor=function() return "UmbraXExecTest" end

-- Minimal DataModel so game/workspace are truthy and support the probe calls
-- the sandbox suite makes (FindFirstChild, GetChildren, GetService, Destroy).
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
-- task.wait THROWS: any surviving anti-tamper hang fails the test immediately.
task = {
  wait = function(n) error("ANTI_TAMPER_BOMB: task.wait(" .. tostring(n) .. ")") end,
  spawn = function() end,
  defer = function() end,
}
`;

function runLua(src) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const captured = [];
    lua.lua_pushjsfunction(L, (L) => {
        const n = lua.lua_gettop(L);
        const parts = [];
        for (let i = 1; i <= n; i++) { lauxlib.luaL_tolstring(L, i); parts.push(lua.lua_tojsstring(L, -1)); lua.lua_pop(L, 1); }
        captured.push(parts.join('\t'));
        return 0;
    });
    lua.lua_setglobal(L, to_luastring('print'));
    const status = lauxlib.luaL_dostring(L, to_luastring(PRELUDE + '\n' + src));
    if (status !== lua.LUA_OK) return { ok: false, output: captured.join('\n'), err: lua.lua_tojsstring(L, -1) };
    return { ok: true, output: captured.join('\n'), err: null };
}

// Scripts that use the executor surface, so the guards are actually exercised.
const SCRIPTS = {
    plain_print:  'print("hello from roblox")',
    arithmetic:   'local x = 41\nprint(x + 1)',
    loop:         'local s = 0 for i = 1, 5 do s = s + i end\nprint(s)',
    string_heavy: 'local a = "game:GetService" local b = "Players"\nprint(a .. "(" .. b .. ")")',
    getgenv:      'getgenv().umbraxFlag = "enabled"\nprint(getgenv().umbraxFlag)',
    exec_mixed:   'local g = getgenv()\ng.name = identifyexecutor()\nprint(g.name, checkcaller())',

    // ── Regressions ─────────────────────────────────────────────────
    // A multi-statement script with a LEADING line comment. Control-flow
    // flattening only fires at ≥3 top-level statements, so the tiny scripts
    // above never exercised it — this one does, across all four variants. The
    // leading `-- …` header used to get the injected `_st=<next>` state update
    // commented out under `+cff`, producing broken Lua (`UmbraX: load failed`).
    // Fixed by stripping comments before flattening (transformer._stripComments).
    cff_commented: [
        '-- UmbraX regression: CFF over a commented, multi-statement script',
        'local Players = game:GetService("Players")',
        'local function greet(who) return "hi, " .. who end',
        'local total = 0',
        'for i = 1, 5 do total = total + i end -- running sum',
        'getgenv().umbraxCff = greet("world") .. " " .. tostring(total)',
        'print(getgenv().umbraxCff)',
    ].join('\n'),

    // Non-ASCII (multi-byte UTF-8) in a COMMENT. The payload-integrity hash used
    // to walk JS code units (charCodeAt) while the emitted Lua walks bytes
    // (string.byte), so an em-dash (1 unit / 3 bytes) diverged and fired the
    // hash bomb. Fixed by hashing UTF-8 bytes (antitamper.computePayloadHash).
    unicode_comment: '-- greeting — em-dash (U+2014) must not brick the build\nprint("unicode comment ok")',

    // Non-ASCII in a STRING — must round-trip through the cipher and print back
    // exactly. Guards against a regression in the byte-accurate string path.
    unicode_string: 'print("café ☕ — déjà vu")',
};

const OPTS = { renameVariables: true, addJunkCode: true, encodeNumbers: true, minStringLength: 1, watermark: true };

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('runtime: obfuscated output ≡ original in a Roblox executor env (game present)');
{
    const t = new Transformer();
    // Run each script under the base pipeline AND with the opt-in layers, since
    // control-flow flattening / splitting reshape the code the guards sit in.
    const variants = [
        { label: '', opts: {} },
        { label: '+cff', opts: { controlFlow: true } },
        { label: '+split', opts: { splitStrings: true } },
        { label: '+indirect', opts: { indirectGlobals: true } },
    ];
    for (const [name, code] of Object.entries(SCRIPTS)) {
        const orig = runLua(code);
        if (!orig.ok) { ok(`original ${name}`, false, 'ORIGINAL failed: ' + orig.err); continue; }
        for (const { label, opts } of variants) {
            let out;
            try { out = t.transform(code, { ...OPTS, ...opts }); }
            catch (e) { ok(`${name}${label}`, false, 'transform threw ' + e.message); continue; }
            const got = runLua(out);
            if (!got.ok) { ok(`${name}${label}`, false, 'OBFUSCATED failed: ' + got.err); continue; }
            ok(`${name}${label}`, got.output === orig.output,
                got.output === orig.output ? '' : `expected ${JSON.stringify(orig.output)} got ${JSON.stringify(got.output)}`);
        }
    }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
process.exit(fail ? 1 : 0);
