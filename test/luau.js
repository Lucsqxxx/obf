// ═══════════════════════════════════════════════════════════════
//  UmbraX — Luau + Exploit support battery
//
//  Section 1: Luau-specific SYNTAX (types, generics, compound assign,
//    continue, string interpolation, if-expr, generalized iteration,
//    numeric/binary literals, floor div, type assertions). luaparse and
//    fengari are both Lua 5.3 and cannot RUN these, so per construct we
//    assert: (a) transform doesn't throw, (b) the OUTER loader is valid
//    Lua 5.3, (c) the construct survives verbatim in the inner script,
//    and where feasible (d) the down-converted inner parses (catches
//    structural corruption around the construct).
//
//  Section 2: Exploit GLOBALS — real runtime equivalence. Executor
//    globals (getgenv, hookfunction, request, writefile, crypt, …) are
//    stubbed as working Lua 5.3 functions; we run original vs obfuscated
//    in fengari and compare print() output. `game` is intentionally left
//    nil so anti-tamper stays inert (as in real offline use). This proves
//    encrypted string ARGUMENTS to exploit calls decrypt at runtime and
//    that global names are never wrongly renamed.
// ═══════════════════════════════════════════════════════════════
'use strict';

const luaparse = require('luaparse');
const Transformer = require('../src/obfuscator/transformer');
const { runLua } = require('./lua-runtime');
const { captureInner } = require('./fixtures');

// Capture the inner pre-loader script via the shared loader-capture helper.
const cap = captureInner();

const t = new Transformer();
const OPTS = { renameVariables: true, addJunkCode: true, encodeNumbers: true, minStringLength: 1, watermark: true };

let s1pass = 0, s1fail = 0, s2pass = 0, s2fail = 0;
const fails = [];

// ── down-converter: strip Luau-only surface so luaparse (5.3) can parse ──
function downConvert(s) {
    return s
        .replace(/`(?:[^`\\]|\\.)*`/g, '""')                                  // interp string
        .replace(/^[ \t]*(export[ \t]+)?type[ \t]+[^\n]*/gm, '')              // type aliases
        .replace(/\s*::\s*[\w.<>{}|&?\[\] ]+/g, '')                           // :: assertions
        .replace(/([)\]\w])\s*(\.\.|\/\/|[-+*/%^])=(?!=)/g, '$1=')            // compound assign
        .replace(/\bcontinue\b/g, 'break')
        .replace(/:[ \t]*\{[^{}]*\}/g, '')                                    // : {table type}
        .replace(/:[ \t]*[A-Za-z_][\w.]*(<[^>]*>)?(\s*[|&]\s*[A-Za-z_][\w.]*(<[^>]*>)?)*\??/g, '') // : T
        .replace(/<[A-Za-z_][\w, ]*>/g, '');                                  // leftover generics
}

// ── Section 1 battery ─────────────────────────────────────────────
// keep: regex that must still match the INNER script (construct survived)
// oracle: false  →  skip down-convert parse (luaparse can't handle even down-converted)
const LUAU = [
    { name: 'type_alias',     code: 'type Vec = {x: number, y: number}\nlocal v: Vec = {x=1,y=2}\nprint(v.x)', keep: /type\s+Vec/ },
    { name: 'export_type',    code: 'export type Pub = number\nlocal n: Pub = 7\nprint(n)', keep: /export\s+type\s+Pub/ },
    { name: 'typed_local',    code: 'local x: number = 5\nprint(x)', keep: /:\s*number/ },
    { name: 'typed_func',     code: 'local function f(a: string): string return a end\nprint(f("hi"))', keep: /:\s*string/ },
    { name: 'generic_func',   code: 'local function id<T>(x: T): T return x end\nprint(id(9))', keep: /<T>/ },
    { name: 'generic_alias',  code: 'type Arr<T> = {T}\nlocal a: Arr<number> = {1,2}\nprint(#a)', keep: /Arr<T>/ },
    { name: 'union_type',     code: 'local x: number | string = 5\nprint(x)', keep: /number\s*\|\s*string/ },
    { name: 'optional_type',  code: 'local x: number? = nil\nprint(x)', keep: /number\?/ },
    { name: 'intersection',   code: 'type A = {a: number}\ntype B = {b: number}\ntype C = A & B\nprint("ok")', keep: /A\s*&\s*B/ },
    { name: 'type_assertion', code: 'local x = 5 :: any\nprint(x)', keep: /::\s*any/ },
    { name: 'compound_add',   code: 'local x = 1\nx += 41\nprint(x)', keep: /\+=/ },
    { name: 'compound_concat',code: 'local s = "a"\ns ..= "b"\nprint(s)', keep: /\.\.=/ },
    { name: 'compound_mul',   code: 'local x = 3\nx *= 4\nprint(x)', keep: /\*=/ },
    { name: 'continue_kw',    code: 'local c=0 for i=1,5 do if i==2 then continue end c+=i end\nprint(c)', keep: /\bcontinue\b/ },
    { name: 'string_interp',  code: 'local n = 5\nprint(`value is {n}!`)', keep: /`value is \{/ },
    { name: 'interp_expr',    code: 'local a,b = 2,3\nprint(`sum {a+b} done`)', keep: /\{a\+b\}/ },
    { name: 'ifelse_expr',    code: 'local x = if true then 10 else 20\nprint(x)', keep: /=\s*if\s+true\s+then\s+.+\s+else\s+/, oracle: false },
    { name: 'gen_iter',       code: 'local t = {4,5,6}\nlocal s=0 for k,v in t do s+=v end\nprint(s)', keep: /in\s+\w+\s+do/, oracle: false },
    { name: 'numeric_sep',    code: 'local n = 1_000_000\nprint(n)', keep: null, oracle: false },
    { name: 'binary_literal', code: 'local b = 0b1010\nprint(b)', keep: null, oracle: false },
    { name: 'floor_div',      code: 'local x = 7 // 2\nprint(x)', keep: /\/\// },
    // hex/binary integer literals are now ENCODED (not preserved) — covered for
    // both preservation-removal and runtime value in Section 3. Here we only
    // assert they transform cleanly and the outer loader stays valid Lua.
    { name: 'hex_literal',    code: 'local h = 0xFF\nprint(h)', keep: null },
    { name: 'unicode_esc',    code: 'local s = "\\u{1F512}"\nprint(#s)', keep: null }, // string content is encrypted → no preserve check
];

console.log('=== Section 1: Luau syntax (no-throw + outer-valid + preserved [+ inner-parse]) ===');
for (const { name, code, keep, oracle } of LUAU) {
    let out, threw = null;
    try { out = t.transform(code, OPTS); } catch (e) { threw = e.message; }
    if (threw) { s1fail++; fails.push(`S1 ${name}: THREW ${threw}`); console.log(`  ${name.padEnd(16)} FAIL — threw ${threw}`); continue; }
    const captured = cap.get();

    let outerOk = true, innerOk = true, kept = true;
    try { luaparse.parse(out, { luaVersion: '5.3' }); } catch { outerOk = false; }
    if (keep && !keep.test(captured)) kept = false;
    if (oracle !== false) { try { luaparse.parse(downConvert(captured), { luaVersion: '5.3' }); } catch { innerOk = false; } }

    const okAll = outerOk && kept && (oracle === false || innerOk);
    if (okAll) { s1pass++; console.log(`  ${name.padEnd(16)} OK${oracle === false ? '  (preserve-only)' : ''}`); }
    else {
        s1fail++;
        const why = [!outerOk && 'outer-invalid', !kept && 'NOT-preserved', !innerOk && oracle !== false && 'inner-corrupt'].filter(Boolean).join(', ');
        fails.push(`S1 ${name}: ${why}`);
        console.log(`  ${name.padEnd(16)} FAIL — ${why}`);
    }
}

// ── Section 2: exploit globals, runtime equivalence ──────────────
// NB: we never define `game`/`workspace`, so anti-tamper stays inert.
const EXPLOIT_PRELUDE = `
local function _id(...) return ... end
getgenv = function() _G.__g = _G.__g or {} return _G.__g end
getrenv = function() return _G end
checkcaller = function() return true end
identifyexecutor = function() return "UmbraXTest" end
getexecutorname = identifyexecutor
hookfunction = function(target, hook) return target end
replaceclosure = hookfunction
hookmetamethod = function(o,n,h) return function() end end
newcclosure = function(f) return f end
clonefunction = function(f) return f end
islclosure = function(f) return true end
iscclosure = function(f) return false end
getrawmetatable = function(o) return getmetatable(o) or {} end
setrawmetatable = function(o,mt) return o end
setreadonly = function(t,b) return t end
isreadonly = function(t) return false end
getnamecallmethod = function() return "GetService" end
setnamecallmethod = function(s) end
getconnections = function(sig) return {} end
fireclickdetector = function() end
firetouchinterest = function() end
fireproximityprompt = function() end
getsenv = function(s) return {} end
getfflag = function(n) return "true" end
getgc = function() return {} end
getreg = function() return {} end
gethui = function() return {} end
request = function(o) return {StatusCode=200, Body="ok", Headers={}} end
http_request = request
syn = {request=request, queue_on_teleport=function() end}
local _fs = {}
writefile = function(p,d) _fs[p]=d end
appendfile = function(p,d) _fs[p]=(_fs[p] or "")..d end
readfile = function(p) return _fs[p] end
isfile = function(p) return _fs[p] ~= nil end
delfile = function(p) _fs[p]=nil end
listfiles = function() return {} end
makefolder = function() end
isfolder = function() return false end
crypt = { base64encode=function(s) return "b64:"..s end, base64decode=function(s) return (s:gsub("^b64:","")) end }
setclipboard = function() end
queue_on_teleport = function() end
typeof = function(v) return type(v) end
`;

function runEquiv(name, code, opts = OPTS) {
    const orig = runLua(EXPLOIT_PRELUDE + '\n' + code);
    if (!orig.ok) { s2fail++; fails.push(`S2 ${name}: ORIGINAL failed ${orig.err}`); console.log(`  ${name.padEnd(18)} FAIL — original errored: ${orig.err}`); return; }
    let out;
    try { out = t.transform(code, opts); } catch (e) { s2fail++; fails.push(`S2 ${name}: transform threw ${e.message}`); console.log(`  ${name.padEnd(18)} FAIL — transform threw ${e.message}`); return; }
    const got = runLua(EXPLOIT_PRELUDE + '\n' + out);
    if (!got.ok) { s2fail++; fails.push(`S2 ${name}: obfuscated failed ${got.err}`); console.log(`  ${name.padEnd(18)} FAIL — obfuscated errored: ${got.err}`); return; }
    if (got.output !== orig.output) { s2fail++; fails.push(`S2 ${name}: expected ${JSON.stringify(orig.output)} got ${JSON.stringify(got.output)}`); console.log(`  ${name.padEnd(18)} FAIL — expected ${JSON.stringify(orig.output)} got ${JSON.stringify(got.output)}`); return; }
    s2pass++; console.log(`  ${name.padEnd(18)} OK  (out=${JSON.stringify(orig.output)})`);
}

console.log('\n=== Section 2: Exploit globals — runtime equivalence (fengari) ===');
runEquiv('getgenv_rw',      'getgenv().myFlag = "enabled"\nprint(getgenv().myFlag)');
runEquiv('identifyexec',    'print(identifyexecutor())');
runEquiv('checkcaller',     'print(checkcaller())');
runEquiv('writefile_rw',    'writefile("config.json", "data123")\nprint(readfile("config.json"))');
runEquiv('isfile_guard',    'if not isfile("a.txt") then writefile("a.txt","1") end\nprint(isfile("a.txt"))');
runEquiv('crypt_b64',       'print(crypt.base64encode("secret"))');
runEquiv('request_http',    'local r = request({Url = "https://example.com/api", Method = "GET"})\nprint(r.StatusCode, r.Body)');
runEquiv('newcclosure',     'local c = newcclosure(function() return "hooked!" end)\nprint(c())');
runEquiv('hookfunction',    'local h = hookfunction(tostring, function() return "x" end)\nprint(type(h))');
runEquiv('islclosure',      'print(islclosure(print))');
runEquiv('getrawmeta',      'local mt = getrawmetatable({})\nsetreadonly(mt, true)\nprint(type(mt))');
runEquiv('namecall',        'print(getnamecallmethod())');
runEquiv('getfflag',        'print(getfflag("DebugDisableTelemetryEphemeral"))');
runEquiv('syn_request',     'local r = syn.request({Url = "https://x.com", Method = "POST", Body = "payload"})\nprint(r.StatusCode)');
runEquiv('mixed_exploit',   'local g = getgenv()\ng.cfg = {speed = 16, jump = "high"}\nwritefile("s.lua", "loadstring(game:HttpGet(\\"u\\"))()")\nprint(g.cfg.speed, g.cfg.jump, isfile("s.lua"))');

// ── Section 3: number encoding (hex/binary) + opt-in layer plumbing ──
let s3pass = 0, s3fail = 0;
function s3(name, cond, detail) {
    if (cond) { s3pass++; console.log(`  ${name.padEnd(22)} OK`); }
    else { s3fail++; fails.push(`S3 ${name}: ${detail || ''}`); console.log(`  ${name.padEnd(22)} FAIL — ${detail || ''}`); }
}
console.log('\n=== Section 3: hex/binary encoding + flag plumbing ===');
// hex/binary literals must (a) be ENCODED (the literal must disappear from the
// _encodeNumbers output — checked in isolation so the cipher stub's own hex
// constants like 0xFFFFFFFF can't false-match) and (b) still evaluate to the
// right value at runtime. fengari is Lua 5.3 and can't run Luau 0b.. literals,
// so the expected value is computed in JS, printed via an injected decimal.
function encEquiv(name, expr, litRe, expected) {
    // (a) encode-only pass: literal gone?
    const encodedSrc = t._encodeNumbers(`local _v = ${expr}`);
    const encoded = !litRe.test(encodedSrc);
    // (b) full transform runs and the printed value matches `expected`.
    const code = `local _v = ${expr}\nprint(_v)`;
    let out;
    try { out = t.transform(code, OPTS); } catch (e) { return s3(name, false, 'transform threw ' + e.message); }
    const got = runLua(out);
    const ran = got.ok && got.output === String(expected);
    s3(name, encoded && ran, !encoded ? 'literal NOT encoded (passed through)' : `runtime: exp ${JSON.stringify(String(expected))} got ${JSON.stringify(got.output)} ${got.err || ''}`);
}
encEquiv('hex_encoded',    '0xFF',        /0xFF/i,    255);
encEquiv('hex_mixed',      '0x10 + 0x20', /0x10|0x20/i, 48);
encEquiv('binary_encoded', '0b1010',      /0b1010/i,  10);
encEquiv('hex_underscore', '0xFF_FF',     /0xFF_FF/i, 65535);
// floats must be LEFT ALONE (encoding them risks precision loss).
(() => {
    t.transform('local f = 3.14\nprint(f)', OPTS);
    const captured = cap.get();
    s3('float_untouched', /3\.14/.test(captured), 'float literal was altered');
})();
// flag plumbing: --split / --cff must actually change the produced output.
(() => {
    const code = 'local s = "hello world this is long" print(s) local a=1 local b=2 local c=3 print(a+b+c)';
    const base = t.transform(code, OPTS);
    const split = t.transform(code, { ...OPTS, splitStrings: true });
    const cff = t.transform(code, { ...OPTS, controlFlow: true });
    // outputs are randomized per-run, so compare runtime behavior + that the
    // option path doesn't throw and still runs equivalently.
    const o = runLua(code), rs = runLua(split), rc = runLua(cff), rb = runLua(base);
    s3('split_layer_runs', rs.ok && rs.output === o.output, rs.err || `exp ${JSON.stringify(o.output)} got ${JSON.stringify(rs.output)}`);
    s3('cff_layer_runs', rc.ok && rc.output === o.output, rc.err || `exp ${JSON.stringify(o.output)} got ${JSON.stringify(rc.output)}`);
    s3('base_layer_runs', rb.ok && rb.output === o.output, rb.err || 'base mismatch');
})();

// ── Section 4: global indirection (runtime equivalence + aliasing) ──
let s4pass = 0, s4fail = 0;
function s4(name, cond, detail) {
    if (cond) { s4pass++; console.log(`  ${name.padEnd(22)} OK`); }
    else { s4fail++; fails.push(`S4 ${name}: ${detail || ''}`); console.log(`  ${name.padEnd(22)} FAIL — ${detail || ''}`); }
}
console.log('\n=== Section 4: global indirection (--indirect) ===');
const IND = { ...OPTS, indirectGlobals: true };
// (a) exploit scripts stay runtime-equivalent WITH indirection on.
const s2Before = s2fail;
runEquiv('ind_getgenv',   'getgenv().flag = "on"\nprint(getgenv().flag)', IND);
runEquiv('ind_writefile', 'writefile("f.txt","hi")\nprint(readfile("f.txt"))', IND);
runEquiv('ind_mixed',     'local g = getgenv()\ng.n = identifyexecutor()\nwritefile("a", "b")\nprint(g.n, isfile("a"))', IND);
runEquiv('ind_request',   'local r = request({Url="https://x", Method="GET"})\nprint(r.StatusCode, r.Body)', IND);
s4('exploit scripts equiv w/ indirection', s2fail === s2Before, 'a runEquiv above failed under indirection');
// (b) indirection ACTUALLY aliases: a bare read produces `local X=getgenv`.
(() => {
    const src = 'local x = getgenv() print(x)';
    const rewritten = t._indirectGlobals(src);
    const aliased = /local\s+\S+=getgenv\b/.test(rewritten) && !/=\s*getgenv\(\)/.test(rewritten);
    s4('aliases a bare global read', aliased, `got: ${rewritten}`);
})();
// (c) safety: reassigned / localized / field globals are left ALONE.
(() => {
    const reassign = t._indirectGlobals('getgenv = nil print(getgenv)');
    const localized = t._indirectGlobals('local getgenv = function() end print(getgenv())');
    const field = t._indirectGlobals('syn.request({})');
    const ok = !/local\s+\S+=getgenv/.test(reassign) && !/local\s+\S+=getgenv\b(?!\s*=)/.test(localized) && !/local\s+\S+=request/.test(field);
    s4('leaves unsafe globals alone', ok, `reassign=${reassign} | localized=${localized} | field=${field}`);
})();

// ── summary ──────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(56)}`);
console.log(`Section 1 (Luau syntax):     ${s1pass}/${s1pass + s1fail} passed`);
console.log(`Section 2 (exploit runtime): ${s2pass}/${s2pass + s2fail} passed`);
console.log(`Section 3 (encoding+flags):  ${s3pass}/${s3pass + s3fail} passed`);
console.log(`Section 4 (indirection):     ${s4pass}/${s4pass + s4fail} passed`);
if (fails.length) { console.log('\nFailures:'); for (const f of fails) console.log('  • ' + f); }
process.exit(s1fail + s2fail + s3fail + s4fail ? 1 : 0);
