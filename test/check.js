// ═══════════════════════════════════════════════════════════════
//  UmbraX — Correctness harness
//
//  Captures the INNER script (the part loadstring'd at runtime inside
//  Roblox) AND the full OUTER loader, validating both with luaparse as
//  Lua 5.3 — no Lua interpreter needed, since the obfuscator emits plain
//  Lua-5.3-compatible code.
// ═══════════════════════════════════════════════════════════════

const luaparse = require('luaparse');
const Transformer = require('../src/obfuscator/transformer');
const { ALL, captureInner } = require('./fixtures');

// Capture the inner script handed to loader.build().
const cap = captureInner();

// Shared battery + a few zcheck-specific edge cases luaparse should accept.
const scripts = Object.assign({}, ALL, {
    empty_str: 'local e = "" print(#e)',
    table_keys: 'local t = {name = "bob", age = 30, ["k"] = 1}\nprint(t.name)',
    float_hex: 'local a = 12345\nlocal b = 0xFF\nlocal c = 3.14\nprint(a + b + c)',
});

const t = new Transformer();
let innerFails = 0, outerFails = 0, threw = 0;

function ctx(src, idx, span = 60) {
    if (idx == null) return '(n/a)';
    return JSON.stringify(src.substring(Math.max(0, idx - span), Math.min(src.length, idx + span)));
}

for (const [name, code] of Object.entries(scripts)) {
    let out;
    try {
        out = t.transform(code, { renameVariables: true, addJunkCode: true, encodeNumbers: true, minStringLength: 1, watermark: true });
    } catch (e) {
        threw++; console.log(`### ${name}: TRANSFORM THREW — ${e.message}`); continue;
    }

    const inner = cap.get();
    let innerOk = true, outerOk = true;
    try { luaparse.parse(inner, { luaVersion: '5.3' }); }
    catch (e) { innerOk = false; innerFails++; console.log(`### ${name}: INNER FAIL @line ${e.line}: ${e.message}\n    ${ctx(inner, e.index)}`); }
    try { luaparse.parse(out, { luaVersion: '5.3' }); }
    catch (e) { outerOk = false; outerFails++; console.log(`### ${name}: OUTER FAIL @line ${e.line}: ${e.message}\n    ${ctx(out, e.index)}`); }

    if (innerOk && outerOk) console.log(`### ${name}: OK  (inner ${inner.length}b, outer ${out.length}b)`);
}

// ── Luau-only constructs luaparse can't parse: assert preservation ──
// luaparse@0.3.1 rejects type annotations / continue / backticks, but Roblox
// compiles them. So we don't parse these — we assert the transformer kept the
// construct intact and (for backticks) didn't break the interpolation binding.
console.log('\n--- Luau-preservation semantic checks ---');
let semFails = 0;
function semCheck(name, code, assertion) {
    t.transform(code, { renameVariables: true, addJunkCode: true, encodeNumbers: true, minStringLength: 1, watermark: true });
    const inner = cap.get();
    const r = assertion(inner);
    console.log(`### ${name}: ${r === true ? 'OK' : 'FAIL — ' + r}`);
    if (r !== true) semFails++;
}
// backtick rename safety: `{n}` must reference whatever `n` was renamed to,
// i.e. the interpolation and the declaration must still agree.
semCheck('backtick-binding', 'local n = 5\nprint(`value is {n}!`)', (inner) => {
    // Number encoding (#70) now rewrites the literal `5` into an arithmetic
    // expression, so we can no longer anchor on `= 5`. Instead locate the name
    // used inside the surviving `{...}` interpolation and assert a matching
    // `local <name> =` declaration exists — that's the binding that must agree.
    const interp = inner.match(/\{([A-Za-z_]\w*)\}/);
    if (!interp) return 'interpolation {...} vanished';
    const usedName = interp[1];
    const declRe = new RegExp(`local\\s+${usedName}\\s*=`);
    if (!declRe.test(inner)) return `interpolation uses {${usedName}} but no matching local decl`;
    return true;
});
// type annotation preserved
semCheck('type-preserved', 'local x: number = 5\nprint(x)', (inner) =>
    /:\s*number/.test(inner) ? true : 'type annotation stripped');
// continue preserved
semCheck('continue-preserved', 'for i=1,5 do if i==2 then continue end end', (inner) =>
    /\bcontinue\b/.test(inner) ? true : 'continue keyword lost');

console.log(`\n=== ${innerFails} inner-parse fail (luaparse luau limits ok), ${outerFails} outer fail, ${threw} threw, ${semFails} semantic fail ===`);
process.exit(outerFails + threw + semFails === 0 ? 0 : 1);
