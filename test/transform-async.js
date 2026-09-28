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

const { runTransform, getQueueStats, MAX_CONCURRENT, MAX_QUEUE_DEPTH } = require('../src/obfuscator/transformAsync');
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

    // ── 6. Concurrency cap: never more than MAX_CONCURRENT jobs running ──
    {
        ok('MAX_CONCURRENT is a sane positive integer', Number.isInteger(MAX_CONCURRENT) && MAX_CONCURRENT >= 1 && MAX_CONCURRENT <= 8,
            `MAX_CONCURRENT=${MAX_CONCURRENT}`);

        // A slow-ish job (enough layers to take tens of ms) fired MAX_CONCURRENT*3
        // times at once. Sample getQueueStats() while they're all in flight and
        // assert `active` never exceeds the cap, even though far more jobs than
        // the cap were requested simultaneously.
        const lines = [];
        for (let i = 0; i < 800; i++) lines.push(`local v${i}=${i} print("x",v${i})`);
        const source = lines.join('\n');
        const opts = { renameVariables: true, addJunkCode: true, encodeNumbers: true, deepNumbers: true };

        let maxObservedActive = 0;
        const sampler = setInterval(() => {
            maxObservedActive = Math.max(maxObservedActive, getQueueStats().active);
        }, 2);

        const jobs = Array.from({ length: MAX_CONCURRENT * 3 }, () => runTransform(source, opts));
        await Promise.all(jobs);
        clearInterval(sampler);

        ok(`active concurrency never exceeded MAX_CONCURRENT (${MAX_CONCURRENT}) under ${MAX_CONCURRENT * 3} simultaneous jobs`,
            maxObservedActive <= MAX_CONCURRENT, `observed peak active=${maxObservedActive}`);
        ok('queue drains back to idle after all jobs settle', getQueueStats().active === 0 && getQueueStats().queued === 0,
            JSON.stringify(getQueueStats()));
    }

    // ── 7. Queue overflow: beyond MAX_QUEUE_DEPTH waiting jobs, reject fast ──
    {
        // Occupy every concurrency slot with a job that won't resolve until we
        // let it (an artificially tiny timeout so it rejects promptly and
        // frees the slot once we're done probing overflow behavior).
        const busySource = 'local x = 1 print(x)';
        const holders = Array.from({ length: MAX_CONCURRENT }, () =>
            runTransform(busySource, { renameVariables: true }, { timeoutMs: 500 }).catch(() => {}));

        // Give the holders a tick to actually start (occupy their slots)
        // before flooding the queue.
        await new Promise(r => setTimeout(r, 5));
        ok('all concurrency slots occupied by the holder jobs', getQueueStats().active === MAX_CONCURRENT,
            JSON.stringify(getQueueStats()));

        // Fill the queue past its cap; the excess should reject immediately
        // with a "busy" error rather than hang around waiting for a slot.
        const overflowCount = MAX_QUEUE_DEPTH + 5;
        const overflowResults = await Promise.allSettled(
            Array.from({ length: overflowCount }, () => runTransform(busySource, { renameVariables: true }, { timeoutMs: 5 })),
        );
        const busyRejections = overflowResults.filter(r => r.status === 'rejected' && /busy/i.test(r.reason.message));
        ok(`at least the excess-over-capacity requests were rejected as busy (queue cap ${MAX_QUEUE_DEPTH})`,
            busyRejections.length >= overflowCount - MAX_QUEUE_DEPTH,
            `got ${busyRejections.length} busy rejections out of ${overflowCount} requests`);

        await Promise.allSettled(holders);
        // Let any queued-but-accepted jobs from the overflow batch finish/timeout
        // before moving on, so they don't bleed into a later test's timing.
        await new Promise(r => setTimeout(r, 50));
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error('UNEXPECTED FAILURE:', e);
    process.exit(1);
});
