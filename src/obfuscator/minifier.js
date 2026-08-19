// ═══════════════════════════════════════════════════════════════
//  UmbraX — Built-in Luau Minifier
//
//  A pure-JS, dependency-free minifier used as the fallback for .minify
//  when no native tool (darklua / luau_beautifier) is installed — so the
//  command always works. Token-based (shares lexer.js), never regexes raw
//  source, so it's Luau-safe (backtick strings, `continue`, type syntax…).
//
//  Strategy: drop comments, then re-emit the token stream with the MINIMAL
//  separators that keep it lexing and parsing identically:
//    • a single space only where two adjacent tokens would otherwise merge
//      into a different token (proven by re-tokenising the pair);
//    • a `;` where a newline had separated a value-ending statement from a
//      following `(`/`[` — collapsing that newline would otherwise create
//      Lua's ambiguous-call bug (`a=b` ⏎ `(f)()` ≠ `a=b(f)()`).
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { tokenize } = require('./lexer');

// Keyword tokens that can terminate an expression (for the ambiguity guard).
const VALUE_END_KW = new Set(['end', 'true', 'false', 'nil']);

// Can token `t` be the last token of an expression/statement value?
function canEndExpr(t) {
    if (!t) return false;
    return t.type === 'name' || t.type === 'number' || t.type === 'string'
        || t.type === 'longstring' || t.type === 'backtick'
        || (t.type === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}'))
        || (t.type === 'keyword' && VALUE_END_KW.has(t.value))
        || t.value === '...';
}

// Would writing a.value immediately followed by b.value re-lex as anything
// other than exactly [a, b]? If so, a separating space is REQUIRED. Re-tokenising
// the concatenation is provably correct: it also catches accidental comment
// starts (`-` `-` → `--`) and long-bracket opens (`[` `[` → `[[`).
function needSpace(a, b) {
    // Conservative guard: always separate a number from a following name /
    // keyword / number / `.`. Our lexer stops a number at the first non-numeric
    // char, but REAL Luau treats e.g. `1p`/`1e` as a malformed number (binary/
    // decimal exponent), so `1print` or `10do` could break on-device even though
    // it re-lexes cleanly here. A space costs nothing and removes the risk.
    if (a.type === 'number'
        && (b.type === 'name' || b.type === 'keyword' || b.type === 'number'
            || b.value === '.' || b.value.startsWith('.'))) {
        return true;
    }
    const merged = a.value + b.value;
    const re = tokenize(merged);
    return !(re.length === 2 && re[0].value === a.value && re[1].value === b.value);
}

// Minify `source`. Never throws (the lexer never throws); returns a string.
function minify(source) {
    const toks = tokenize(String(source)).filter(t => t.type !== 'comment');
    let out = '';
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (i > 0) {
            const prev = toks[i - 1];
            const hadNewline = source.slice(prev.end, t.start).indexOf('\n') !== -1;
            if (hadNewline && canEndExpr(prev) && (t.value === '(' || t.value === '[')) {
                out += ';';           // keep the statement boundary the newline implied
            } else if (needSpace(prev, t)) {
                out += ' ';
            }
        }
        out += t.value;
    }
    return out;
}

module.exports = { minify, needSpace, canEndExpr };
