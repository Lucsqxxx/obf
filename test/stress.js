// Stress harness: bugs here are nondeterministic, so run each script under MANY
// seeds and report the failure rate + a sample of distinct error messages.
// Parses the INNER loadstring'd payload (what Roblox actually runs).
const luaparse = require('luaparse');
const Transformer = require('../src/obfuscator/transformer');
const { ALL, captureInner } = require('./fixtures');

// Capture inner script handed to the loader packer.
const cap = captureInner();
const getCaptured = () => cap.get();

const scripts = ALL;

const N = Number(process.argv[2] || 40);
const t = new Transformer();
let grandFail = 0, grandTotal = 0;

for (const [name, code] of Object.entries(scripts)) {
  let fail = 0;
  const samples = new Map(); // err -> {ctx,count}
  for (let s = 0; s < N; s++) {
    try {
      t.transform(code, { renameVariables:true, addJunkCode:true, encodeNumbers:true, minStringLength:1, watermark:true });
    } catch (e) {
      fail++; const k = 'THROW: '+e.message;
      samples.set(k, (samples.get(k)||{count:0,ctx:''})); samples.get(k).count++;
      continue;
    }
    const captured = getCaptured();
    // luaparse is Lua 5.3, not Luau. Down-convert the few Luau-only surface forms
    // that are nonetheless VALID so we don't get false lexer errors:
    //  - compound assignment  x+=1  ->  x=1   (keeps it parseable; we only care
    //    that structure around it is valid, the engine never touches these ops)
    //  - `continue` keyword    ->  `break`
    const forOracle = captured
      .replace(/([%)\]\w])\s*(\+|-|\*|\/|%|\^|\.\.)=(?!=)/g, '$1=')
      .replace(/\bcontinue\b/g, 'break')
      // Luau-only surface forms luaparse can't parse but Roblox compiles:
      //  - backtick interpolated strings  ->  a neutral string literal
      //  - `type X = ...` aliases          ->  removed
      //  - `: Type` annotations            ->  removed (keeps structure valid)
      .replace(/`(?:[^`\\]|\\.)*`/g, '""')
      .replace(/^[ \t]*(export[ \t]+)?type[ \t]+[^\n]*/gm, '')
      .replace(/:[ \t]*\{[^{}]*\}/g, '')
      .replace(/:[ \t]*[A-Za-z_][\w.]*(?:<[^>]*>)?(\??)/g, '')
      // generic type params on functions/aliases:  id<T>(  ->  id(
      .replace(/<[A-Za-z_][\w, ]*>/g, '');
    try { luaparse.parse(forOracle, { luaVersion:'5.3' }); }
    catch (e) {
      fail++;
      const k = e.message.replace(/\[\d+:\d+\]/,'[L:C]').replace(/'[^']*'/g, m=>m); // keep msg
      const a = Math.max(0,(e.index||0)-45), b=Math.min(captured.length,(e.index||0)+45);
      if (!samples.has(k)) samples.set(k, {count:0, ctx: JSON.stringify(captured.substring(a,b))});
      samples.get(k).count++;
    }
  }
  grandFail += fail; grandTotal += N;
  const status = fail === 0 ? 'PASS' : `FAIL ${fail}/${N}`;
  console.log(`${name.padEnd(12)} ${status}`);
  if (fail) {
    let shown=0;
    for (const [k,v] of [...samples.entries()].sort((a,b)=>b[1].count-a[1].count)) {
      if (shown++>=3) break;
      console.log(`    (${v.count}x) ${k}`);
      if (v.ctx) console.log(`         ${v.ctx}`);
    }
  }
}
console.log(`\nTOTAL: ${grandTotal-grandFail}/${grandTotal} passed, ${grandFail} failed`);
process.exit(grandFail ? 1 : 0);
