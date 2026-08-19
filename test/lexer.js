// ═══════════════════════════════════════════════════════════════
//  UmbraX — Lexer suite
//
//  The lexer is the single source of truth for "code vs literal" — every
//  transform iterates its tokens and nothing else regexes raw source. A
//  mis-tokenized long string or backtick would let an obfuscation pass reach
//  INTO a string literal (corrupting it) or treat literal text AS code. This
//  suite pins the tricky boundaries: nested long-bracket levels, `--[[ ]]`
//  long comments, backtick interpolation with nested braces, greedy operators,
//  Luau number forms, and escape decoding via stringValue().
//
//  Run:  node test/lexer.js
// ═══════════════════════════════════════════════════════════════
'use strict';

const { tokenize, stringValue } = require('../src/obfuscator/lexer');

let pass = 0, fail = 0;
const failures = [];

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ✓ ${label}`); }
    else {
        fail++;
        failures.push(`${label} — got ${a}, want ${e}`);
        console.log(`  ✗ ${label} — got ${a}, want ${e}`);
    }
}

// Compact [type, value] view of the token stream — the property everything
// downstream actually depends on.
function tv(src) {
    return tokenize(src).map(t => [t.type, t.value]);
}
// Just the token types, for structural assertions where value is noise.
function types(src) {
    return tokenize(src).map(t => t.type);
}

console.log('lexer: token boundaries + escape decoding');

// ── Basic classification ─────────────────────────────────────────
check('keyword vs name',   tv('local x'),        [['keyword', 'local'], ['name', 'x']]);
check('luau keywords',     types('type continue export typeof'),
                                                  ['keyword', 'keyword', 'keyword', 'keyword']);
check('call punctuation',  tv('print(1)'),
      [['name', 'print'], ['punct', '('], ['number', '1'], ['punct', ')']]);

// ── Greedy multi-char operators (must not split) ─────────────────
check('compound +=',       tv('x+=1'),   [['name', 'x'], ['punct', '+='], ['number', '1']]);
check('compound ..=',      tv('s..=x'),  [['name', 's'], ['punct', '..='], ['name', 'x']]);
check('concat vs dots',    tv('a..b'),   [['name', 'a'], ['punct', '..'], ['name', 'b']]);
check('vararg ...',        tv('f(...)'), [['name', 'f'], ['punct', '('], ['punct', '...'], ['punct', ')']]);
check('type cast ::',      tv('x::any'), [['name', 'x'], ['punct', '::'], ['name', 'any']]);
check('floor div //',      tv('7//2'),   [['number', '7'], ['punct', '//'], ['number', '2']]);
check('eq vs assign',      tv('a==b'),   [['name', 'a'], ['punct', '=='], ['name', 'b']]);

// ── Numbers (Luau forms) ─────────────────────────────────────────
check('hex literal',       types('0xFF'),      ['number']);
check('binary literal',    types('0b1010'),    ['number']);
check('digit separators',  tv('1_000_000'),    [['number', '1_000_000']]);
check('float + exponent',  tv('1.5e-3'),       [['number', '1.5e-3']]);
check('leading dot float', tv('.5'),           [['number', '.5']]);
check('dot method not num', tv('a.b'),         [['name', 'a'], ['punct', '.'], ['name', 'b']]);

// ── Strings: short ───────────────────────────────────────────────
check('single-token dq string', types('"hi"'),           ['string']);
check('single-token sq string', types("'hi'"),           ['string']);
check('escaped quote stays in', types('"a\\"b"'),         ['string']);
check('string then code',       tv('"x"..y'),
      [['string', '"x"'], ['punct', '..'], ['name', 'y']]);

// ── Long strings + long comments (level tracking) ────────────────
check('long string level 0',    types('[[abc]]'),         ['longstring']);
check('long string level 2',    types('[==[a]]b]==]'),    ['longstring']);
check('long string holds code',
      tv('x=[[ print(1) ]]'),
      [['name', 'x'], ['punct', '='], ['longstring', '[[ print(1) ]]']]);
check('line comment dropped-as-token',
      types('x=1 -- trailing'),
      ['name', 'punct', 'number', 'comment']);
check('long comment single token',
      types('--[[ multi\nline ]] x'),
      ['comment', 'name']);
check('bracket-index not longstring',
      tv('t[1]'),
      [['name', 't'], ['punct', '['], ['number', '1'], ['punct', ']']]);

// ── Backtick interpolation (nested braces must not close early) ───
check('backtick single token',  types('`hi {n}`'),        ['backtick']);
check('backtick nested braces',
      tv('`{ {a=1}.a }`'),
      [['backtick', '`{ {a=1}.a }`']]);
check('backtick then code',
      tv('`x`..y'),
      [['backtick', '`x`'], ['punct', '..'], ['name', 'y']]);

// ── stringValue() escape decoding ────────────────────────────────
function sv(src) { return stringValue(tokenize(src)[0]); }
check('decode \\n',        sv('"a\\nb"'),      'a\nb');
check('decode \\t',        sv('"a\\tb"'),      'a\tb');
check('decode \\\\',       sv('"a\\\\b"'),     'a\\b');
check('decode \\x41',      sv('"\\x41"'),      'A');
check('decode \\65 (dec)', sv('"\\65"'),       'A');
check('decode \\u{1F512}', sv('"\\u{1F512}"'), '🔒');
check('decode \\z skip spaces', sv('"a\\z   b"'), 'ab');
// NOTE: `\z` also skips newlines in real Lua, but the short-string reader
// treats a raw newline as an unterminated string (deliberate guard), so the
// `\z`-across-a-newline idiom is not supported here. luaparse (the validator
// gate) handles it; this lexer does not. Pinned so the limitation is explicit.
check('long string raw (no escapes)', sv('[[a\\nb]]'), 'a\\nb');
check('long string strips leading NL', sv('[[\nhello]]'), 'hello');
check('backtick keeps braces verbatim', sv('`sum {a+b}`'), 'sum {a+b}');

// ── Robustness: never throws on malformed input ──────────────────
try {
    tokenize('"unterminated');
    tokenize('[[unterminated');
    tokenize('`unterminated {');
    tokenize('local x = ');
    pass++; console.log('  ✓ malformed input does not throw');
} catch (err) {
    fail++;
    failures.push(`malformed input threw — ${err.message}`);
    console.log(`  ✗ malformed input threw — ${err.message}`);
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  • ' + f); }
process.exit(fail ? 1 : 0);
