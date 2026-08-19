// ═══════════════════════════════════════════════════════════════
//  UmbraX — Native tool runner
//
//  Thin, crash-proof wrappers around two OPTIONAL external binaries:
//
//    • darklua           (Rust)  — `minify <IN> <OUT>` : Luau/Lua minifier
//    • luau_beautifier   (C++)   — `[--minify] <FILE>`  : beautify OR minify
//
//  Neither ships with the repo. Each is located at call time via, in order:
//    1. an explicit env var  (DARKLUA_BIN / LUAU_BEAUTIFIER_BIN)
//    2. the bare name on PATH
//    3. a repo-local cache dir (.darklua-cache/ , .luaufmt-cache/)
//  — the SAME discovery ladder test/luau-real.js uses for the luau binary.
//
//  When a binary is absent every wrapper returns { ok:false, reason:'missing' }
//  instead of throwing, so the bot degrades gracefully (command reports the
//  tool is unavailable) rather than crashing. This module NEVER throws.
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { execFileSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// Per-tool discovery config. `exe` is the bare binary name; `probe` is a cheap
// argument set that exits 0 when the binary is runnable ("does it work?").
const TOOLS = {
    darklua: {
        envVar:   'DARKLUA_BIN',
        exe:      IS_WIN ? 'darklua.exe' : 'darklua',
        cacheDir: '.darklua-cache',
        probe:    ['--version'],
    },
    luauBeautifier: {
        envVar:   'LUAU_BEAUTIFIER_BIN',
        // Upstream's build emits `luau-beautifier`; accept a couple of common names.
        exe:      IS_WIN ? 'luau-beautifier.exe' : 'luau-beautifier',
        altNames: IS_WIN ? ['luau_beautifier.exe'] : ['luau_beautifier'],
        cacheDir: '.luaufmt-cache',
        probe:    ['--help'],  // argc==1 → displayHelp(), exits 0
    },
    // luau-format — a small, maintained Luau reformatter (stdin → stdout). Used
    // as the SECONDARY beautify engine: tried after luau_beautifier, before the
    // built-in pure-JS beautifier. Version probe exits 0 when runnable.
    luauFormat: {
        envVar:   'LUAU_FORMAT_BIN',
        exe:      IS_WIN ? 'luau-format.exe' : 'luau-format',
        altNames: IS_WIN ? ['luau_format.exe'] : ['luau_format'],
        cacheDir: '.luaufmt-cache',
        probe:    ['--version'],
    },
};

// Resolved-path cache: null = not yet probed, false = probed & absent, string = path.
const _resolved = Object.create(null);

// Locate a tool's binary. Returns an absolute-or-PATH-relative command string,
// or null if none of the candidates run. Result is memoised (including misses)
// so we don't re-probe the filesystem on every command invocation.
function locate(name) {
    if (name in _resolved) return _resolved[name] || null;

    const cfg = TOOLS[name];
    if (!cfg) { _resolved[name] = false; return null; }

    const candidates = [];
    if (process.env[cfg.envVar]) candidates.push(process.env[cfg.envVar]);
    candidates.push(cfg.exe);
    for (const alt of (cfg.altNames || [])) candidates.push(alt);
    candidates.push(path.join(__dirname, '..', '..', cfg.cacheDir, cfg.exe));
    for (const alt of (cfg.altNames || [])) {
        candidates.push(path.join(__dirname, '..', '..', cfg.cacheDir, alt));
    }

    for (const c of candidates) {
        try {
            execFileSync(c, cfg.probe, { stdio: 'ignore' });
            _resolved[name] = c;
            return c;
        } catch { /* try next candidate */ }
    }
    _resolved[name] = false;
    return null;
}

// True if the tool's binary can be found & run on this host.
function isAvailable(name) { return locate(name) !== null; }

// Force re-discovery (used by tests that install/remove a stub binary).
function _resetCache() { for (const k of Object.keys(_resolved)) delete _resolved[k]; }

// Run `fn(tmpDir)` with a private temp directory that is always cleaned up.
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrax-nt-'));
    try { return fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// ── darklua minify ───────────────────────────────────────────────
// `darklua minify [--column-span N] <INPUT> <OUTPUT>` — file→file. We stage the
// source in a temp file, run, then read the emitted output file back.
function runDarkluaMinify(source, opts = {}) {
    const bin = locate('darklua');
    if (!bin) return { ok: false, reason: 'missing', error: 'darklua binary not found' };

    return withTempDir(dir => {
        const inFile  = path.join(dir, 'in.luau');
        const outFile = path.join(dir, 'out.luau');
        // No BOM: darklua's parser (like luau) rejects a leading U+FEFF.
        fs.writeFileSync(inFile, String(source), { encoding: 'utf8' });

        const argv = ['minify'];
        if (Number.isInteger(opts.columnSpan) && opts.columnSpan > 0) {
            argv.push('--column-span', String(opts.columnSpan));
        }
        argv.push(inFile, outFile);

        try {
            execFileSync(bin, argv, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (e) {
            const stderr = (e.stderr || '').toString().trim();
            return { ok: false, reason: 'error', error: stderr || e.message };
        }

        try {
            const output = fs.readFileSync(outFile, 'utf8');
            return { ok: true, output };
        } catch (e) {
            return { ok: false, reason: 'error', error: `no output produced: ${e.message}` };
        }
    });
}

// ── luau_beautifier ──────────────────────────────────────────────
// `luau-beautifier [options] <FILE>` — reads a file, prints result to stdout,
// errors to stderr. `--minify` flips output mode from beautify to minify.
function runLuauBeautifier(source, opts = {}) {
    const bin = locate('luauBeautifier');
    if (!bin) return { ok: false, reason: 'missing', error: 'luau_beautifier binary not found' };

    return withTempDir(dir => {
        const inFile = path.join(dir, 'in.luau');
        fs.writeFileSync(inFile, String(source), { encoding: 'utf8' });

        const argv = [];
        if (opts.minify)         argv.push('--minify');
        if (opts.noSolve)        argv.push('--nosolve');
        if (opts.ignoreTypes)    argv.push('--ignoretypes');
        argv.push(inFile);

        try {
            const output = execFileSync(bin, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return { ok: true, output };
        } catch (e) {
            const stderr = (e.stderr || '').toString().trim();
            return { ok: false, reason: 'error', error: stderr || e.message };
        }
    });
}

// ── luau-format ──────────────────────────────────────────────────
// `luau-format <FILE>` — reads a file, prints the reformatted source to stdout.
// We stage the source in a temp file, run, and read stdout back. Guarded so an
// empty (or whitespace-only) result is treated as a failure rather than silently
// wiping the user's code — the caller then falls through to the next engine.
function runLuauFormat(source, opts = {}) {
    const bin = locate('luauFormat');
    if (!bin) return { ok: false, reason: 'missing', error: 'luau-format binary not found' };

    return withTempDir(dir => {
        const inFile = path.join(dir, 'in.luau');
        fs.writeFileSync(inFile, String(source), { encoding: 'utf8' });

        const argv = [];
        if (Number.isInteger(opts.indentWidth) && opts.indentWidth > 0) {
            argv.push('--indent-width', String(opts.indentWidth));
        }
        argv.push(inFile);

        let output;
        try {
            output = execFileSync(bin, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            const stderr = (e.stderr || '').toString().trim();
            return { ok: false, reason: 'error', error: stderr || e.message };
        }
        // Empty output means the tool produced nothing usable — never hand that
        // back as a "successful" beautify; let the caller try the next engine.
        if (!output || output.trim().length === 0) {
            return { ok: false, reason: 'error', error: 'luau-format produced empty output' };
        }
        return { ok: true, output };
    });
}

module.exports = {
    isAvailable,
    locate,
    runDarkluaMinify,
    runLuauBeautifier,
    runLuauFormat,
    _resetCache,
    TOOLS,
};
