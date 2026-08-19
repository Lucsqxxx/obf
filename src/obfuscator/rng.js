// ═══════════════════════════════════════════════════════════════
//  UmbraX — shared pseudo-random source
//
//  A single process-wide random hook so obfuscation output can be made
//  REPRODUCIBLE for a given seed. Every module (transformer, loader,
//  engine, antitamper) draws its randomness from `rng()` here instead of
//  calling Math.random() directly. With no seed set, `rng()` IS
//  Math.random — byte-for-byte the historical behaviour, so nothing about
//  a normal (unseeded) build changes. When a seed is set via seed(n), a
//  deterministic mulberry32 stream replaces it, so the same input + same
//  seed + same options yields identical output — which makes bug reports
//  ("this exact build broke") replayable and lets the hardening passes be
//  iterated on safely.
//
//  Reproducibility caveat: determinism holds only while the SEQUENCE of
//  draws is fixed. Two builds are identical only if they run the same code
//  path pulling the same number of values in the same order.
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

let _draw = Math.random;   // active source; Math.random until a seed is set

// mulberry32 — tiny, fast, well-distributed 32-bit PRNG. Same generator the
// fuzz suite uses, so seeds behave consistently across tests and runtime.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Draw a float in [0, 1) from the active source (Math.random or a seeded stream). */
function rng() {
    return _draw();
}

/**
 * Install a deterministic seeded stream. Pass a finite number to make output
 * reproducible; pass null/undefined to fall back to Math.random (the default).
 * Returns nothing — call rng()/randInt() afterwards to draw.
 */
function seed(value) {
    if (value === null || value === undefined) { _draw = Math.random; return; }
    const n = Number(value) >>> 0;
    _draw = mulberry32(n);
}

/** True when a deterministic seed is currently installed. */
function isSeeded() {
    return _draw !== Math.random;
}

/** Inclusive integer in [min, max] drawn from the active source. */
function randInt(min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
}

/** Polymorphic identifier: `_` + base36 slice of a fresh draw. */
function rname(a = 2, b = 8) {
    // Build the base36 body from rng() so seeded builds get stable names too.
    // Math.random().toString(36) can't be reproduced, so synthesise digits.
    let body = '';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const len = b - a;
    for (let i = 0; i < len; i++) body += chars[Math.floor(rng() * 36)];
    return '_' + body;
}

module.exports = { rng, seed, isSeeded, randInt, rname, mulberry32 };
