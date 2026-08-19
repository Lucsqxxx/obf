// ═══════════════════════════════════════════════════════════════
//  UmbraX — Shared test fixtures
//
//  One battery of Luau/Lua scripts + the loader-capture helper, imported
//  by every harness (test/run.js, zcheck.js, zstress.js, zluau.js) so a
//  regression case is added in exactly one place.
//
//  Each entry: { code, runnable }.
//    runnable === true  → the ORIGINAL is valid Lua 5.3 and can be executed
//                          in fengari, so it participates in the runtime-
//                          equivalence layer. Roblox/Luau-only scripts (game,
//                          type annotations, `continue`, backticks) set this
//                          false — they're still parsed/validated, just not run.
// ═══════════════════════════════════════════════════════════════
'use strict';

const loader = require('../src/obfuscator/loader');

// ── loader.build capture helper ──────────────────────────────────
// Monkey-patch loader.build so a harness can grab the INNER pre-loader script
// (what Roblox loadstring's) for validation. Returns { get, restore }.
//   get()      → the most recently captured inner script
//   restore()  → undo the patch
function captureInner() {
    const orig = loader.build;
    let last = null;
    loader.build = function (script, watermark) { last = script; return orig.call(loader, script, watermark); };
    return { get: () => last, restore: () => { loader.build = orig; } };
}

// ── The battery ──────────────────────────────────────────────────
const FIXTURES = {
    // — runnable in fengari (Lua 5.3): participate in runtime equivalence —
    basic:        { code: 'print("hello")', runnable: true },
    arithmetic:   { code: 'local x=10 local y=20 print("sum", x+y)', runnable: true },
    concat:       { code: 'print("a".."b".."c")', runnable: true },
    bracketless:  { code: 'print "bracketless"', runnable: true },
    loop:         { code: 'local t=0 for i=1,100 do t=t+i end print(t)', runnable: true },
    whileloop:    { code: 'local i=0 while i<5 do i=i+1 end print(i)', runnable: true },
    repeatloop:   { code: 'local i=0 repeat i=i+1 until i>=3 print(i)', runnable: true },
    nestedfn:     { code: 'local function add(a,b) return a+b end print(add(2,3))', runnable: true },
    closures:     { code: 'local function mk() local n=0 return function() n=n+1 return n end end local c=mk() print(c()..c()..c())', runnable: true },
    tables:       { code: 'local t={1,2,3} local s=0 for _,v in ipairs(t) do s=s+v end print(s)', runnable: true },
    tablekeys:    { code: 'local t={name="bob",age=3} print(t.name, t.age)', runnable: true },
    strings:      { code: 'print(("hello"):upper(), #"abcd")', runnable: true },
    multiret:     { code: 'local function f() return 1,2 end local a,b=f() print(a+b)', runnable: true },
    numbers:      { code: 'local a=12345 local b=99 print(a+b)', runnable: true },
    escapes:      { code: 'print("tab\\tend") print("q\\"x")', runnable: true },
    longstr:      { code: 'local s=[[line1\nline2]] print(#s)', runnable: true },
    unicode:      { code: 'print("emoji 🔒 done")', runnable: true },
    cond:         { code: 'local x=7 if x>5 then print("big") else print("small") end', runnable: true },
    fornum:       { code: 'local s=0 for i=1,4 do for j=1,3 do s=s+i*j end end print(s)', runnable: true },
    forgen:       { code: 'local t={10,20,30} local s=0 for idx,val in ipairs(t) do s=s+idx*val end print(s)', runnable: true },
    shadow:       { code: 'local x=1 local function f() local x=2 return x end print(f(), x)', runnable: true },
    bracketindex: { code: 'local t={} t[1]=function(s) return s end print(t[1]"hi")', runnable: true },
    multiassign:  { code: 'local a, b, c = 1, 2, 3 print(a+b+c)', runnable: true },
    methodchain2: { code: 'local s = ("x"):rep(3):upper() print(s)', runnable: true },
    nested_deep:  { code: 'for a=1,3 do for b=1,3 do if a==b then print(a) end end end', runnable: true },
    tablecomma:   { code: 'local t = {a=1, b=2, c=3} local s=0 for _,v in pairs(t) do s=s+v end print(s)', runnable: true },
    // CFF hoisting regressions: statements with commas/`=` inside braces that
    // the old regex-based hoister mis-split. Exercised under --cff in layer 4.
    cff_bracehoist: { code: 'local cfg = {speed=16, jump=50} local mult = 2 local total = cfg.speed * mult + cfg.jump print(total)', runnable: true },
    cff_multiinit:  { code: 'local a, b = 3, {x=1, y=2} local c = a + b.x + b.y print(c)', runnable: true },

    // — Luau / Roblox-only: parsed & validated, NOT run (no fengari baseline) —
    roblox:       { code: 'local Players = game:GetService("Players")\nlocal lp = Players.LocalPlayer\nprint(lp.Name)', runnable: false },
    roblox_api:   { code: 'local Players = game:GetService("Players")\nlocal lp = Players.LocalPlayer\nlocal char = lp.Character\nlocal hrp = char:WaitForChild("HumanoidRootPart")\nhrp.CFrame = CFrame.new(0, 50, 0)', runnable: false },
    method_chain: { code: 'game:GetService("Players"):GetPlayers()', runnable: false },
    complex:      { code: 'local HttpService = game:GetService("HttpService")\nlocal function send(data)\nlocal json = HttpService:JSONEncode(data)\npcall(function() print(json) end)\nend\nfor _, v in ipairs(workspace:GetDescendants()) do\nif v:IsA("BasePart") then\nsend({name=v.Name})\nend\nend', runnable: false },
    types:        { code: 'type Point = {x: number, y: number}\nlocal pos: Point = {x=1,y=2}\nprint(pos.x)', runnable: false },
    continue_kw:  { code: 'local x = 0\nx += 1\nfor i=1,10 do if i==5 then continue end x += i end\nprint(x)', runnable: false },
    typeof:       { code: 'print(typeof(game))', runnable: false },
    exploit:      { code: 'local env = getgenv()\nlocal raw = getrawmetatable(game)\nlocal old = hookfunction(print, function(...) return old(...) end)\nif checkcaller() then return end', runnable: false },
    backtick:     { code: 'local n = 5\nprint(`value is {n}!`)', runnable: false },
    generic:      { code: 'local function id<T>(x: T): T return x end\nprint(id(9))', runnable: false },
};

// Convenience projections.
const RUNNABLE = Object.fromEntries(Object.entries(FIXTURES).filter(([, v]) => v.runnable).map(([k, v]) => [k, v.code]));
const ALL = Object.fromEntries(Object.entries(FIXTURES).map(([k, v]) => [k, v.code]));

module.exports = { FIXTURES, RUNNABLE, ALL, captureInner };
