// ═══════════════════════════════════════════════════════════════
//  Test helper: run Lua in fengari (Lua 5.3) with a Roblox-ish shim.
//
//  fengari ships none of bit32 / loadstring / getfenv / unpack, so we
//  prepend a small polyfill. The obfuscator's loader is written to
//  degrade outside Roblox (anti-tamper is inert when `game` is nil),
//  so with bit32 + loadstring present the script runs and we can
//  compare its print() output to the un-obfuscated original.
// ═══════════════════════════════════════════════════════════════

const { lua, lauxlib, lualib, to_luastring } = require('fengari');

// Lua 5.3 polyfill providing the bits the generated code expects.
const POLYFILL = `
local function u32(x) return x & 0xFFFFFFFF end
bit32 = {
  band   = function(a,b,...) local r=u32(a)&u32(b) for _,v in ipairs({...}) do r=r&u32(v) end return u32(r) end,
  bor    = function(a,b,...) local r=u32(a)|u32(b) for _,v in ipairs({...}) do r=r|u32(v) end return u32(r) end,
  bxor   = function(a,b,...) local r=u32(a)~u32(b) for _,v in ipairs({...}) do r=r~u32(v) end return u32(r) end,
  bnot   = function(a) return u32(~u32(a)) end,
  lshift = function(a,n) if n>=32 or n<=-32 then return 0 end if n<0 then return u32(a)>>(-n) end return u32(u32(a)<<n) end,
  rshift = function(a,n) if n>=32 or n<=-32 then return 0 end if n<0 then return u32(u32(a)<<(-n)) end return u32(a)>>n end,
  lrotate= function(a,n) n=n%32 a=u32(a) return u32((a<<n)|(a>>(32-n))) end,
  rrotate= function(a,n) n=n%32 a=u32(a) return u32((a>>n)|(a<<(32-n))) end,
  arshift= function(a,n) a=u32(a) if n>=32 then return (a&0x80000000)~=0 and 0xFFFFFFFF or 0 end return u32(a>>n) end,
}
loadstring = load
unpack = table.unpack
`;

/**
 * Run `src` Lua, returning { ok, output, err }. `output` is everything passed
 * to print(), newline-joined (tabs between args, like real Lua print).
 */
function runLua(src) {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);

    const captured = [];
    // Replace print with a capturing version.
    lua.lua_pushjsfunction(L, (L) => {
        const n = lua.lua_gettop(L);
        const parts = [];
        for (let i = 1; i <= n; i++) {
            // Use luaL_tolstring so numbers/bools/etc. stringify like print.
            lauxlib.luaL_tolstring(L, i);
            parts.push(lua.lua_tojsstring(L, -1));
            lua.lua_pop(L, 1);
        }
        captured.push(parts.join('\t'));
        return 0;
    });
    lua.lua_setglobal(L, to_luastring('print'));

    const full = POLYFILL + '\n' + src;
    const status = lauxlib.luaL_dostring(L, to_luastring(full));
    if (status !== lua.LUA_OK) {
        const err = lua.lua_tojsstring(L, -1);
        return { ok: false, output: captured.join('\n'), err };
    }
    return { ok: true, output: captured.join('\n'), err: null };
}

module.exports = { runLua };
