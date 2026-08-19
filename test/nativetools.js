// ═══════════════════════════════════════════════════════════════
//  UmbraX — Native tool integration suite
//
//  Covers the darklua / luau_beautifier plumbing on two levels:
//
//   1. Command-handler logic (.minify, .beautify) via dependency-injected
//      FAKE nativetools — deterministic, runs on every platform, exercises
//      every user-facing branch (unavailable / ok / error / fallback).
//
//   2. Real nativetools plumbing (temp-file staging, argv, stdout capture,
//      graceful "missing" degradation) against an EXECUTABLE STUB that mimics
//      each tool's real CLI contract. Building an executable stub needs a
//      POSIX shebang+chmod, so this section SKIPS on win32 (we can't fabricate
//      a real .exe) — the same SKIP-when-absent philosophy as test/luau-real.js.
//
//  Run:  node test/nativetools.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const nativetools          = require('../src/obfuscator/nativetools');
const LuaBeautifier        = require('../src/obfuscator/beautifier');
const createMinifyHandler  = require('../src/bot/commands/minify');
const createBeautifyHandler = require('../src/bot/commands/beautify');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; failures.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

// ── mock Discord message: captures whatever the handler replies with ──
function makeMsg() {
    const replies = [];
    return {
        attachments: { first: () => null },
        reply: async (payload) => { replies.push(payload); return payload; },
        _replies: replies,
    };
}
// First embed's title/description from a captured reply payload.
function embedOf(msg) {
    const p = msg._replies[0];
    const e = p && p.embeds && p.embeds[0];
    return e ? e.data : {};
}

console.log('nativetools: shape & degradation (no binary required)');

// locate() on an unknown tool is null, never throws.
ok('locate(unknown) → null', nativetools.locate('does-not-exist') === null);

// The wrappers must NEVER throw, whatever the host has installed. When the tool
// is absent they return {ok:false, reason:'missing'}; if a real binary happens
// to be on this host they return {ok:true,...}. Either way: a well-formed object.
function assertWrapperShape(label, res) {
    ok(`${label}: returns object`, res && typeof res === 'object', JSON.stringify(res));
    ok(`${label}: ok is boolean`, typeof res.ok === 'boolean');
    if (!res.ok) ok(`${label}: reason present when !ok`, res.reason === 'missing' || res.reason === 'error', JSON.stringify(res));
}
let dRes, bRes;
let threw = false;
try { dRes = nativetools.runDarkluaMinify('local  x   =  1'); } catch (e) { threw = true; failures.push('runDarkluaMinify threw: ' + e.message); }
ok('runDarkluaMinify never throws', !threw);
if (dRes) assertWrapperShape('runDarkluaMinify', dRes);

threw = false;
try { bRes = nativetools.runLuauBeautifier('local x=1', {}); } catch (e) { threw = true; failures.push('runLuauBeautifier threw: ' + e.message); }
ok('runLuauBeautifier never throws', !threw);
if (bRes) assertWrapperShape('runLuauBeautifier', bRes);

// ── command handlers via injected FAKE nativetools ───────────────
console.log('\nnativetools: .minify handler branches (fake deps)');

(async () => {
    // (a) no minifier installed → graceful "unavailable"
    {
        const handler = createMinifyHandler({ nativetools: { isAvailable: () => false } });
        const msg = makeMsg();
        await handler(msg, ['local x = 1']);
        ok('.minify: unavailable notice', /Minifier Unavailable/.test(embedOf(msg).title || ''), embedOf(msg).title);
    }

    // (b) darklua available, succeeds → "Code Minified" + engine label
    {
        const fake = {
            isAvailable: (n) => n === 'darklua',
            runDarkluaMinify: () => ({ ok: true, output: 'local x=1' }),
            runLuauBeautifier: () => { throw new Error('should not be called'); },
        };
        const handler = createMinifyHandler({ nativetools: fake });
        const msg = makeMsg();
        await handler(msg, ['local x = 1 -- comment']);
        ok('.minify: darklua success title', /Code Minified/.test(embedOf(msg).title || ''), embedOf(msg).title);
        ok('.minify: darklua engine labelled', /darklua/.test(embedOf(msg).description || ''), embedOf(msg).description);
    }

    // (c) darklua absent, luau_beautifier present → used as fallback
    {
        let usedMinifyFlag = null;
        const fake = {
            isAvailable: (n) => n === 'luauBeautifier',
            runLuauBeautifier: (_src, opts) => { usedMinifyFlag = !!opts.minify; return { ok: true, output: 'local x=1' }; },
        };
        const handler = createMinifyHandler({ nativetools: fake });
        const msg = makeMsg();
        await handler(msg, ['local x = 1']);
        ok('.minify: luau_beautifier fallback', /luau_beautifier/.test(embedOf(msg).description || ''), embedOf(msg).description);
        ok('.minify: fallback passes --minify', usedMinifyFlag === true);
    }

    // (d) tool present but errors → "Minify Failed" with the error surfaced
    {
        const fake = {
            isAvailable: (n) => n === 'darklua',
            runDarkluaMinify: () => ({ ok: false, reason: 'error', error: 'syntax error near <eof>' }),
        };
        const handler = createMinifyHandler({ nativetools: fake });
        const msg = makeMsg();
        await handler(msg, ['this is not lua {{{']);
        ok('.minify: error surfaced', /Minify Failed/.test(embedOf(msg).title || ''), embedOf(msg).title);
    }

    // (e) empty input rejected before touching any tool
    {
        const handler = createMinifyHandler({ nativetools: { isAvailable: () => true } });
        const msg = makeMsg();
        await handler(msg, ['   ']);
        ok('.minify: empty input rejected', /Empty Input/.test(embedOf(msg).title || ''), embedOf(msg).title);
    }

    console.log('\nnativetools: .beautify native-vs-fallback (fake deps)');

    // (f) native luau_beautifier present → used, labelled as such
    {
        const fake = {
            isAvailable: (n) => n === 'luauBeautifier',
            runLuauBeautifier: () => ({ ok: true, output: 'local x = 1\n' }),
        };
        const handler = createBeautifyHandler({ beautifier: new LuaBeautifier(), nativetools: fake });
        const msg = makeMsg();
        await handler(msg, ['local x=1']);
        ok('.beautify: native engine labelled', /luau_beautifier/.test(embedOf(msg).description || ''), embedOf(msg).description);
    }

    // (g) no nativetools at all → falls back to the pure-JS beautifier, still works
    {
        const handler = createBeautifyHandler({ beautifier: new LuaBeautifier() });
        const msg = makeMsg();
        await handler(msg, ['local x=1']);
        ok('.beautify: built-in fallback works', /Code Beautified/.test(embedOf(msg).title || ''), embedOf(msg).title);
        ok('.beautify: built-in engine labelled', /built-in/.test(embedOf(msg).description || ''), embedOf(msg).description);
    }

    // (h) native present but fails → silently falls back to built-in (never errors)
    {
        const fake = {
            isAvailable: (n) => n === 'luauBeautifier',
            runLuauBeautifier: () => ({ ok: false, reason: 'error', error: 'boom' }),
        };
        const handler = createBeautifyHandler({ beautifier: new LuaBeautifier(), nativetools: fake });
        const msg = makeMsg();
        await handler(msg, ['local x=1']);
        ok('.beautify: native failure → built-in fallback', /built-in/.test(embedOf(msg).description || ''), embedOf(msg).description);
    }

    // ── live plumbing against an executable stub (POSIX only) ────────
    console.log('\nnativetools: live plumbing (executable stub)');
    if (process.platform === 'win32') {
        console.log('  live-stub: SKIPPED — cannot fabricate an executable stub on win32.');
        console.log('  (darklua.exe / luau-beautifier.exe are real PE binaries; the fake-deps');
        console.log('   tests above cover handler logic, and CI/Linux exercises this section.)');
    } else {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbrax-stub-'));
        try {
            // darklua stub: `--version` → exit 0; `minify [--column-span N] IN OUT`
            // → write a "minified" (blank-lines-stripped) copy of IN to OUT.
            const darklua = path.join(dir, 'darklua');
            fs.writeFileSync(darklua,
                '#!/bin/sh\n' +
                'if [ "$1" = "--version" ]; then echo "darklua-stub 0.0.0"; exit 0; fi\n' +
                'if [ "$1" = "minify" ]; then\n' +
                '  shift\n' +
                '  if [ "$1" = "--column-span" ]; then shift; shift; fi\n' +
                '  IN="$1"; OUT="$2"\n' +
                '  grep -v "^[[:space:]]*$" "$IN" > "$OUT"\n' +
                '  exit 0\n' +
                'fi\n' +
                'exit 1\n', { mode: 0o755 });
            fs.chmodSync(darklua, 0o755);

            // luau_beautifier stub: `--help` → exit 0; else last arg is the file,
            // echo its contents to stdout (mimics beautify → stdout contract).
            const beaut = path.join(dir, 'luau-beautifier');
            fs.writeFileSync(beaut,
                '#!/bin/sh\n' +
                'if [ "$1" = "--help" ]; then echo "usage"; exit 0; fi\n' +
                'for a in "$@"; do FILE="$a"; done\n' +
                'cat "$FILE"\n' +
                'exit 0\n', { mode: 0o755 });
            fs.chmodSync(beaut, 0o755);

            process.env.DARKLUA_BIN = darklua;
            process.env.LUAU_BEAUTIFIER_BIN = beaut;
            nativetools._resetCache();

            ok('live: darklua discovered via env', nativetools.isAvailable('darklua'));
            ok('live: luau_beautifier discovered via env', nativetools.isAvailable('luauBeautifier'));

            const dr = nativetools.runDarkluaMinify('local x = 1\n\n\nlocal y = 2\n');
            ok('live: darklua minify ok', dr.ok, JSON.stringify(dr));
            ok('live: darklua stripped blank lines', dr.ok && !/\n\s*\n/.test(dr.output), JSON.stringify(dr));

            const br = nativetools.runLuauBeautifier('local z = 3\n', {});
            ok('live: luau_beautifier ran, stdout captured', br.ok && /local z = 3/.test(br.output), JSON.stringify(br));
        } finally {
            delete process.env.DARKLUA_BIN;
            delete process.env.LUAU_BEAUTIFIER_BIN;
            nativetools._resetCache();
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
    process.exit(fail ? 1 : 0);
})();
