// ═══════════════════════════════════════════════════════════════
//  UmbraX — Off-thread transform execution suite
//
//  transformAsync.js exists to keep a large/slow obfuscation job from
//  blocking the bot's main event loop. This suite pins:
//    1. Correctness — a job run through the worker produces IDENTICAL
//       output to running transform() directly on the main thread (same
//       seed, same options), so moving execution off-thread never changes
//       what gets emitted.
//    2. Non-blocking — the main thread's event loop keeps ticking while a
//       multi-second job runs (proven by a setInterval firing during it;
//       this would be impossible if the job ran synchronously in-process).
//    3. Timeout handling — an artificially tiny timeout rejects cleanly and
//       terminates the worker instead of hanging.
//    4. Error propagation — a bad job (throws inside transform) rejects
//       with a real message instead of crashing the process.
//    5. Concurrency — multiple jobs in flight at once don't interfere with
//       each other's output (each worker is fully isolated).
//
//  Run:  node test/transform-async.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const { runTransform } = require('../src/obfuscator/transformAsync');
const Transformer = require('../src/obfuscator/transformer');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const OPTS = { renameVariables: true, addJunkCode: true, encodeNumbers: true, minStringLength: 1, seed: 20260823 };

(async () => {
    console.log('transform-async: correctness, non-blocking, timeout, error, concurrency');

    // ── 1. Correctness: worker output matches direct main-thread output ──
    // Same seed → the RNG stream (and therefore every polymorphic name,
    // junk block, cipher key, etc.) is identical, so the two outputs must
    // be byte-for-byte equal if the worker is running the same code path.
    {
        const source = 'local function greet(n) return "hi, "..n end\nprint(greet("world"))';
        const direct = new Transformer().transform(source, OPTS);
        const { output: viaWorker, stats } = await runTransform(source, OPTS);
        ok('worker output matches direct transform (same seed)', viaWorker === direct,
            viaWorker === direct ? '' : `lengths: direct=${direct.length} worker=${viaWorker.length}`);
        ok('stats came back with expected shape', stats && typeof stats.bytesOutput === 'number' && typeof stats.stringsEncrypted === 'number',
            JSON.stringify(stats));
    }

    // ── 2. Non-blocking: the main thread's event loop keeps ticking ──
    {
        // A script large enough that transform() takes a meaningfully long
        // time (hundreds of ms+), so a setInterval has room to fire during it.
        const lines = [];
        for (let i = 0; i < 3000; i++) lines.push(`local v${i}=${i} print("line",v${i})`);
        const bigSource = lines.join('\n');

        let ticks = 0;
        const iv = setInterval(() => { ticks++; }, 20);
        const t0 = Date.now();
        await runTransform(bigSource, { renameVariables: true, addJunkCode: true, encodeNumbers: true, controlFlow: true });
        const elapsed = Date.now() - t0;
        clearInterval(iv);
        ok('main thread stayed responsive during a multi-hundred-ms job',
            ticks > 0, `job took ${elapsed}ms but 0 interval ticks fired — main thread was blocked`);
    }

    // ── 3. Timeout: rejects cleanly, doesn't hang ──
    {
        const lines = [];
        for (let i = 0; i < 500; i++) lines.push(`local v${i}=${i}`);
        const source = lines.join('\n');
        let threw = null;
        try {
            await runTransform(source, { renameVariables: true, encodeNumbers: true, deepNumbers: true }, { timeoutMs: 1 });
        } catch (e) { threw = e; }
        ok('artificially tiny timeout rejects', !!threw, 'expected a rejection');
        ok('timeout error message is descriptive', threw && /timed out/i.test(threw.message), threw && threw.message);
    }

    // ── 4. Error propagation: a bad job rejects instead of crashing ──
    {
        let threw = null;
        try {
            // transform() indexes into `source` immediately; null blows up
            // with a real TypeError inside the worker.
            await runTransform(null, {});
        } catch (e) { threw = e; }
        ok('a job that throws rejects (not crash/hang)', !!threw, 'expected a rejection');
        ok('error message propagated from the worker', threw && threw.message.length > 0, threw && threw.message);
    }

    // ── 5. Concurrency: parallel jobs don't cross-contaminate output ──
    {
        const a = 'print("AAAAAAAAAA")';
        const b = 'print("BBBBBBBBBB")';
        const [ra, rb] = await Promise.all([
            runTransform(a, { renameVariables: true, encodeNumbers: true, seed: 1 }),
            runTransform(b, { renameVariables: true, encodeNumbers: true, seed: 2 }),
        ]);
        const directA = new Transformer().transform(a, { renameVariables: true, encodeNumbers: true, seed: 1 });
        const directB = new Transformer().transform(b, { renameVariables: true, encodeNumbers: true, seed: 2 });
        ok('concurrent job A matches its own direct transform', ra.output === directA);
        ok('concurrent job B matches its own direct transform', rb.output === directB);
        ok('concurrent jobs did not cross-contaminate', ra.output !== rb.output);
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error('UNEXPECTED FAILURE:', e);
    process.exit(1);
});
