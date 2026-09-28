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
//  This module runs each job in a dedicated worker_threads Worker instead,
//  so the main thread stays free. A fresh worker is spawned per job (no
//  pooling) rather than reusing a long-lived worker — jobs are fully
//  isolated from one another this way, which matters because a seeded
//  build temporarily mutates the shared RNG module (rng.js) for its
//  duration; isolation removes any need to reason about that across
//  concurrent jobs. Worker startup is a few ms, negligible next to typical
//  job duration.
//
//  Moving jobs off the main thread solves "one big job freezes the bot", but
//  by itself it does NOT solve "a burst of simultaneous jobs saturates the
//  host's CPU cores" — spawning an unbounded number of worker threads that
//  each do real, heavy CPU work will still degrade everything running on the
//  same machine (the bot's own event loop included, since it's competing for
//  the same physical cores) even though none of them technically block it.
//  runTransform() therefore gates actual execution through a small
//  concurrency-limited queue: only MAX_CONCURRENT jobs run at once, and
//  anything beyond MAX_QUEUE_DEPTH is rejected immediately with a "busy"
//  error rather than growing an unbounded backlog in memory.
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

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_TIMEOUT_MS = 45_000;

// How many transform jobs may run concurrently. Each one is real, sustained
// CPU work on its own thread, so this is deliberately conservative: reserve
// at least one core for the main thread (Discord gateway, every other
// command) and cap the upper bound regardless of core count, since each
// worker also carries its own V8 heap. Overridable via env var for hosts
// where the default doesn't fit (e.g. a small VPS, or a very large box).
const MAX_CONCURRENT = (() => {
    const fromEnv = parseInt(process.env.UMBRAX_MAX_CONCURRENT_JOBS, 10);
    if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
    return Math.max(1, Math.min(4, os.cpus().length - 1));
})();

// Beyond this many WAITING jobs (not counting ones already running), reject
// new requests immediately instead of letting the backlog grow unbounded —
// protects memory/fairness if many users obfuscate large files at once.
const MAX_QUEUE_DEPTH = 25;

let active = 0;
const queue = []; // { source, options, timeoutMs, resolve, reject }

function scheduleNext() {
    if (active >= MAX_CONCURRENT || queue.length === 0) return;
    const job = queue.shift();
    active++;
    spawnWorkerJob(job.source, job.options, job.timeoutMs)
        .then(job.resolve, job.reject)
        .finally(() => { active--; scheduleNext(); });
}

/**
 * Run `new Transformer().transform(source, options)` in an isolated worker
 * thread, subject to the concurrency limit above. Resolves `{ output, stats }`
 * (stats is transformer.getStats()'s plain-object return value). Rejects with
 * a plain Error on any failure — a transform-time error (bad input, an
 * internal throw), a timeout ("Obfuscation timed out after Nms — try a
 * smaller script or fewer layers."), the worker exiting/erroring
 * unexpectedly, or the queue being full ("Server is busy...").
 *
 * @param {string} source
 * @param {object} options            transformer.transform()'s options object
 * @param {{timeoutMs?: number}} [opts]
 */
function runTransform(source, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        if (active < MAX_CONCURRENT) {
            active++;
            spawnWorkerJob(source, options, timeoutMs)
                .then(resolve, reject)
                .finally(() => { active--; scheduleNext(); });
            return;
        }
        if (queue.length >= MAX_QUEUE_DEPTH) {
            reject(new Error('Server is busy processing other obfuscation requests right now — please try again in a moment.'));
            return;
        }
        queue.push({ source, options, timeoutMs, resolve, reject });
    });
}

// Current load, exposed for callers that want to give feedback (e.g. a
// "queued, N ahead of you" status line) without needing their own bookkeeping.
function getQueueStats() {
    return { active, queued: queue.length, maxConcurrent: MAX_CONCURRENT, maxQueueDepth: MAX_QUEUE_DEPTH };
}

// The actual worker-thread spawn + lifecycle handling. Unexported — always
// goes through runTransform()'s concurrency gate above.
function spawnWorkerJob(source, options, timeoutMs) {
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

module.exports = { runTransform, getQueueStats, DEFAULT_TIMEOUT_MS, MAX_CONCURRENT, MAX_QUEUE_DEPTH };
