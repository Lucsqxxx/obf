// ═══════════════════════════════════════════════════════════════
//  UmbraX — Bot-layer suite
//
//  The obfuscator core is heavily tested; the bot layer was not. This pins
//  the pure, logic-carrying helpers that decide what the user gets:
//  flag parsing (--cff/--split/…), byte formatting, protection tiers,
//  uptime formatting, and fetchSource's input-resolution + validation
//  branches (missing input, bad extension, oversize, download failure,
//  successful download). fetchSource is async and hits `fetch`, so we stub
//  a minimal message/attachment and the global fetch — no live Discord client.
//
//  Run:  node test/bot.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const {
    parseLayerFlags, formatBytes, bar, protectionLevel, uptime, fetchSource,
} = require('../src/bot/helpers');
const { MAX_FILE_SIZE } = require('../src/bot/constants');

let pass = 0, fail = 0;
const failures = [];
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; failures.push(`${label} — got ${a}, want ${e}`); console.log(`  ✗ ${label} — got ${a}, want ${e}`); }
}
function ok(label, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; failures.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('bot: pure helpers');

// ── parseLayerFlags ──────────────────────────────────────────────
eq('no flags → empty layers', parseLayerFlags(['print("x")']), { layers: {}, args: ['print("x")'] });
eq('--cff → controlFlow',     parseLayerFlags(['--cff', 'code']), { layers: { controlFlow: true }, args: ['code'] });
eq('--flatten alias',         parseLayerFlags(['--flatten']), { layers: { controlFlow: true }, args: [] });
eq('all four flags',
   parseLayerFlags(['--cff', '--split', '--deep', '--indirect', 'x']),
   { layers: { controlFlow: true, splitStrings: true, deepNumbers: true, indirectGlobals: true }, args: ['x'] });
eq('case-insensitive',        parseLayerFlags(['--CFF']), { layers: { controlFlow: true }, args: [] });
eq('unknown --flag kept as arg', parseLayerFlags(['--bogus', 'y']), { layers: {}, args: ['--bogus', 'y'] });
eq('undefined args safe',     parseLayerFlags(undefined), { layers: {}, args: [] });
eq('flag order preserved in rest',
   parseLayerFlags(['a', '--cff', 'b']), { layers: { controlFlow: true }, args: ['a', 'b'] });

// ── formatBytes ──────────────────────────────────────────────────
eq('bytes < 1KB',   formatBytes(512),      '512 B');
eq('exactly 1KB',   formatBytes(1024),     '1.0 KB');
eq('KB range',      formatBytes(1536),     '1.5 KB');
eq('MB range',      formatBytes(1048576),  '1.00 MB');
eq('MB fractional', formatBytes(1572864),  '1.50 MB');
eq('zero',          formatBytes(0),        '0 B');

// ── bar ──────────────────────────────────────────────────────────
eq('bar empty',  bar(0, 10, 10),  '░'.repeat(10));
eq('bar full',   bar(10, 10, 10), '█'.repeat(10));
eq('bar half',   bar(5, 10, 10),  '█'.repeat(5) + '░'.repeat(5));
ok('bar clamps overflow', bar(20, 10, 10) === '█'.repeat(10), 'overflow should clamp to full, no extra cells');
ok('bar length constant', bar(3, 10, 12).length === 12);

// ── protectionLevel ──────────────────────────────────────────────
eq('tier standard', protectionLevel(1000).label,  'STANDARD');
eq('tier high',     protectionLevel(25000).label, 'HIGH');
eq('tier extreme',  protectionLevel(40000).label, 'EXTREME');
eq('tier maximum',  protectionLevel(60000).label, 'MAXIMUM');
eq('tier boundary 20000 = standard', protectionLevel(20000).label, 'STANDARD'); // > not >=
eq('tier boundary 20001 = high',     protectionLevel(20001).label, 'HIGH');

// ── uptime ───────────────────────────────────────────────────────
eq('uptime seconds', uptime(45 * 1000),                 '0m 45s');
eq('uptime minutes', uptime((5 * 60 + 30) * 1000),      '5m 30s');
eq('uptime hours',   uptime((2 * 3600 + 15 * 60 + 5) * 1000), '2h 15m 5s');
eq('uptime days',    uptime((3 * 86400 + 4 * 3600 + 7 * 60) * 1000), '3d 4h 7m');

// ── fetchSource (async, stubbed fetch) ───────────────────────────
function msg({ attachment = null, content = null, } = {}) {
    return { content, attachments: { first: () => attachment } };
}
function attach({ name = 'script.lua', size = 100, url = 'http://x/f', } = {}) {
    return { name, size, url };
}

(async () => {
    // no input at all
    eq('fetchSource: no input',
       await fetchSource(msg(), []),
       { error: 'Provide either code after the command or a `.lua`/`.luau`/`.txt` file attachment.' });

    // inline code path
    eq('fetchSource: inline code',
       await fetchSource(msg(), ['print("hi")']),
       { source: 'print("hi")' });
    eq('fetchSource: inline code joins args',
       await fetchSource(msg(), ['a', 'b', 'c']),
       { source: 'a b c' });

    // ── Newline preservation (the syntax-gate bypass regression) ──────────
    // The dispatcher splits on /\s+/, so multi-line pasted code arrives as
    // whitespace-collapsed tokens. fetchSource must rebuild it from the RAW
    // message content, or a script whose first line is a `--` comment folds
    // onto one line and the whole thing becomes a comment (validator sees an
    // empty program → broken code sails through). See helpers.reconstructInline.
    const multi = '-- header comment\nlocal x = 1\nprint(x)';
    const rNL = await fetchSource(
        msg({ content: '.obfuscate ' + multi }),
        ['--', 'header', 'comment', 'local', 'x', '=', '1', 'print(x)'],
    );
    ok('fetchSource: inline preserves newlines',
       rNL.source === multi, JSON.stringify(rNL.source));

    // Leading layer-flags are peeled from the raw content; code keeps newlines.
    const rFlags = await fetchSource(
        msg({ content: '.obfuscate --cff --deep local y = 2\nprint(y)' }),
        ['local', 'y', '=', '2', 'print(y)'],   // callers strip flags before calling
    );
    ok('fetchSource: peels leading flags, keeps newline',
       rFlags.source === 'local y = 2\nprint(y)', JSON.stringify(rFlags.source));

    // A leading `hwid:` token (.secure) is peeled too.
    const rHwid = await fetchSource(
        msg({ content: '.secure hwid:ABC123 print("hi")' }),
        ['print("hi")'],
    );
    ok('fetchSource: peels hwid token',
       rHwid.source === 'print("hi")', JSON.stringify(rHwid.source));

    // Flags-only message (no code) → treated as no input.
    const rFlagsOnly = await fetchSource(msg({ content: '.obfuscate --cff' }), []);
    ok('fetchSource: flags-only is no input',
       !!rFlagsOnly.error, JSON.stringify(rFlagsOnly));

    // bad extension
    const r1 = await fetchSource(msg({ attachment: attach({ name: 'evil.exe' }) }), []);
    ok('fetchSource: rejects bad extension', r1.error && /Only .* files/.test(r1.error), JSON.stringify(r1));

    // oversize
    const r2 = await fetchSource(msg({ attachment: attach({ size: MAX_FILE_SIZE + 1 }) }), []);
    ok('fetchSource: rejects oversize', r2.error && /Maximum file size/.test(r2.error), JSON.stringify(r2));

    // successful download (stub global fetch)
    const origFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, text: async () => 'downloaded content' });
    const r3 = await fetchSource(msg({ attachment: attach({ name: 'ok.luau' }) }), []);
    eq('fetchSource: downloads file', r3, { source: 'downloaded content', fileName: 'ok.luau' });

    // download HTTP error
    global.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
    const r4 = await fetchSource(msg({ attachment: attach() }), []);
    ok('fetchSource: HTTP error surfaced', r4.error && /HTTP 404/.test(r4.error), JSON.stringify(r4));

    // download throws
    global.fetch = async () => { throw new Error('network down'); };
    const r5 = await fetchSource(msg({ attachment: attach() }), []);
    ok('fetchSource: fetch throw surfaced', r5.error && /network down/.test(r5.error), JSON.stringify(r5));

    global.fetch = origFetch;

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`${pass} passed, ${fail} failed`);
    if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
    process.exit(fail ? 1 : 0);
})();
