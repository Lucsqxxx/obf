// ═══════════════════════════════════════════════════════════════
//  UmbraX — Transform worker entry point
//
//  Runs INSIDE a worker_threads Worker (see transformAsync.js, which spawns
//  it). One job per worker: take { source, options } from workerData, run
//  the full transform pipeline, post back { ok, output, stats } or
//  { ok:false, error }. The worker process exits naturally once this
//  finishes (no event loop handles kept open), so the caller doesn't need
//  to explicitly terminate() on the success path.
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { parentPort, workerData } = require('worker_threads');
const Transformer = require('./transformer');

try {
    const { source, options } = workerData;
    const t = new Transformer();
    const output = t.transform(source, options);
    const stats = t.getStats();
    parentPort.postMessage({ ok: true, output, stats });
} catch (err) {
    parentPort.postMessage({ ok: false, error: (err && err.message) ? err.message : String(err) });
}
