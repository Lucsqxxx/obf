// ═══════════════════════════════════════════════════════════════
//  UmbraX — Off-thread transform execution
//
//  transformer.transform() is synchronous, single-pass, token-based JS —
//  for a large or heavily-layered script it can take several seconds of
//  pure CPU work (see the benchmark notes below). Node is single-threaded,
//  so calling it directly from the bot's message handler blocks EVERYTHING
//  else the process is doing for that entire duration: Discord gateway
//  heartbeats, every other user's commands, giveaway timers, all of it.
//  One person obfuscating a large file would freeze the bot for everyone.
//
//  This module runs the job in a dedicated worker_threads Worker instead,
//  so the main thread stays free. A fresh worker is spawned per job (no
//  pooling) rather than reusing a long-lived worker — jobs are fully
//  isolated from one another this way, which matters because a seeded
//  build temporarily mutates the shared RNG module (rng.js) for its
//  duration; isolation removes any need to reason about that across
//  concurrent jobs. Worker startup is a few ms, negligible next to typical
//  job duration.
//
//  Benchmarked (see the perf test suite): a ~700KB script with every heavy
//  layer enabled runs in ~4s; a ~5MB script with every heavy layer enabled
//  runs in ~36s. DEFAULT_TIMEOUT_MS and the bot's MAX_FILE_SIZE are chosen
//  together so that even the worst-case combination (max file size × every
//  layer at once) finishes with headroom before the timeout fires.
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Run `new Transformer().transform(source, options)` in an isolated worker
 * thread. Resolves `{ output, stats }` (stats is transformer.getStats()'s
 * plain-object return value). Rejects with a plain Error on any failure —
 * a transform-time error (bad input, an internal throw), a timeout ("Obfuscation
 * timed out after Nms — try a smaller script or fewer layers."), or the worker
 * exiting/erroring unexpectedly.
 *
 * @param {string} source
 * @param {object} options            transformer.transform()'s options object
 * @param {{timeoutMs?: number}} [opts]
 */
function runTransform(source, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(path.join(__dirname, 'transformWorker.js'), {
                workerData: { source, options },
            });
        } catch (err) {
            reject(err);
            return;
        }

        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.removeAllListeners();
            // Safe even if the worker already exited naturally — terminate()
            // on a finished worker is a documented no-op, not an error.
            worker.terminate().catch(() => {});
            fn(arg);
        };

        const timer = setTimeout(() => {
            finish(reject, new Error(`Obfuscation timed out after ${timeoutMs}ms — try a smaller script or fewer layers.`));
        }, timeoutMs);
        if (timer.unref) timer.unref();

        worker.once('message', (msg) => {
            if (msg && msg.ok) finish(resolve, { output: msg.output, stats: msg.stats });
            else finish(reject, new Error((msg && msg.error) || 'Unknown worker error'));
        });
        worker.once('error', (err) => finish(reject, err));
        worker.once('exit', (code) => {
            if (!settled && code !== 0) finish(reject, new Error(`Obfuscation worker stopped unexpectedly (exit code ${code}).`));
        });
    });
}

module.exports = { runTransform, DEFAULT_TIMEOUT_MS };
