// ═══════════════════════════════════════════════════════════════
//  UmbraX — Luau Code Beautifier
//  Proper indentation, spacing, and formatting.
//  Shares the project lexer (lexer.js); trivia (newlines/whitespace)
//  are reconstructed from the gaps between token offsets.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

const { tokenize: lexTokenize } = require('./lexer');

// Statement-start keywords that NEVER appear mid-expression, so a newline can be
// safely forced before them when the previous token ends a value. (`do` and
// `function` are contextual — excluded; `if` is guarded by canEndExpr so Luau
// `x = if c then …` expressions are left intact.)
const STMT_START = new Set(['local', 'if', 'while', 'for', 'repeat', 'return', 'break']);
// Keywords that must begin their own line.
const LINE_LEAD = new Set(['end', 'until', 'elseif', 'else']);
// Block-opening keywords after which the block body starts on a new line.
const BLOCK_OPEN = new Set(['then', 'do', 'else', 'repeat']);
// Keyword tokens that can terminate an expression (for the break guard).
const VALUE_END_KW = new Set(['end', 'true', 'false', 'nil']);

// Can token `t` be the last token of an expression/statement value?
function canEndExpr(t) {
    if (!t) return false;
    return t.type === 'name' || t.type === 'number' || t.type === 'string'
        || t.type === 'longstring' || t.type === 'backtick'
        || (t.type === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}' || t.value === '...'))
        || (t.type === 'keyword' && VALUE_END_KW.has(t.value));
}

// Should a newline be FORCED between real tokens prev→cur when the source had
// none? Only at unambiguous structural boundaries — see the sets above. A line
// comment always forces a break (else the next token would join the comment).
function shouldBreak(prev, cur) {
    if (!prev) return false;
    if (prev.type === 'comment' && prev.level === -1) return true;
    if (cur.type === 'keyword' && LINE_LEAD.has(cur.value)) return true;
    if (prev.type === 'keyword' && BLOCK_OPEN.has(prev.value)) return true;
    if (prev.type === 'punct' && prev.value === ';') return true;
    if (cur.type === 'keyword' && STMT_START.has(cur.value) && canEndExpr(prev)) return true;
    return false;
}

class LuaBeautifier {
    constructor(options = {}) {
        this.indent = options.indent || '    ';
    }

    beautify(source) {
        const tokens = this._tokenize(source);
        let depth = 0;
        let output = '';
        let lineStart = true;

        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];

            if (tok.type === 'newline') {
                output += '\n';
                lineStart = true;
                continue;
            }

            // Depth decrease BEFORE indenting: end, else, elseif, until
            if (tok.type === 'keyword' && ['end', 'else', 'elseif', 'until'].includes(tok.value)) {
                depth = Math.max(0, depth - 1);
            }

            // Add indent at line start
            if (lineStart && tok.type !== 'whitespace') {
                output += this.indent.repeat(depth);
                lineStart = false;
            }

            // Write token
            if (tok.type === 'whitespace') {
                if (!lineStart) output += ' ';
            } else {
                output += tok.value;
            }

            // Depth increase AFTER writing: then, do, else, repeat, function (block-opening)
            if (tok.type === 'keyword') {
                if (['then', 'do', 'else', 'repeat'].includes(tok.value)) {
                    depth++;
                } else if (tok.value === 'function') {
                    // Only increase depth if not anonymous inline (followed by `(` on same line without `=` before)
                    const hasEnd = this._scanForwardForEnd(tokens, i);
                    if (hasEnd) depth++;
                }
            }
        }

        // Clean up trailing whitespace and excessive blank lines
        return output.split('\n')
            .map(line => line.trimEnd())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim() + '\n';
    }

    _scanForwardForEnd(tokens, fromIdx) {
        // Check if this function has a matching end (not a single-line lambda)
        let depth = 0;
        for (let i = fromIdx + 1; i < tokens.length; i++) {
            if (tokens[i].type === 'newline') return true; // multi-line → yes
            if (tokens[i].type === 'keyword' && tokens[i].value === 'end') return depth === 0;
        }
        return true;
    }

    // Tokenize via the shared lexer, then re-insert trivia (newline/whitespace)
    // reconstructed from the gaps between adjacent token offsets. The lexer
    // drops whitespace, so we synthesize it here for the formatter.
    _tokenize(source) {
        const lexed = lexTokenize(source);
        const out = [];
        let cursor = 0;

        const emitTrivia = (from, to) => {
            const gap = source.slice(from, to);
            if (!gap) return;
            // Split into newline / horizontal-whitespace runs so the formatter
            // can distinguish line breaks from spacing.
            let buf = '';
            const flushWs = () => { if (buf) { out.push({ type: 'whitespace', value: ' ' }); buf = ''; } };
            for (const ch of gap) {
                if (ch === '\n') { flushWs(); out.push({ type: 'newline', value: '\n' }); }
                else if (ch === '\r') { /* fold CR into following LF */ }
                else buf += ch;
            }
            flushWs();
        };

        let prevReal = null;
        for (const t of lexed) {
            const before = out.length;
            emitTrivia(cursor, t.start);
            cursor = t.end;
            // Did the original source already put a newline between the previous
            // real token and this one? (emitTrivia would have pushed one.)
            let hadNewline = false;
            for (let k = before; k < out.length; k++) if (out[k].type === 'newline') { hadNewline = true; break; }
            // No newline in the source but the structure demands a line break →
            // synthesise one (dropping any inline space we'd otherwise emit).
            if (prevReal && !hadNewline && shouldBreak(prevReal, t)) {
                if (out.length && out[out.length - 1].type === 'whitespace') out.pop();
                out.push({ type: 'newline', value: '\n' });
            }
            out.push({ type: this._mapType(t), value: t.value });
            prevReal = t;
        }
        emitTrivia(cursor, source.length);
        return out;
    }

    // Map lexer token types → the formatter's expected vocabulary.
    _mapType(t) {
        switch (t.type) {
            case 'keyword': return 'keyword';
            case 'name': return 'identifier';
            case 'number': return 'number';
            case 'string':
            case 'longstring':
            case 'backtick': return 'string';
            case 'comment': return 'comment';
            default: return 'punct';
        }
    }
}

module.exports = LuaBeautifier;