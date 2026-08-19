
// ═══════════════════════════════════════════════════════════════
//  UmbraX — Luau Lexer
//  ONE tokenizer. Single source of truth for "what is code vs literal".
//  Every transform iterates these tokens; nothing regexes raw source.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

// Lua/Luau keywords. `continue`, `type`, `export`, `typeof` are Luau-only but
// harmless to treat as keywords for tokenisation purposes.
const KEYWORDS = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
    'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or',
    'repeat', 'return', 'then', 'true', 'until', 'while',
    'continue', 'export', 'type', 'typeof',
]);

// Token types:
//   'name'      — identifier (not a keyword)
//   'keyword'   — reserved word
//   'number'    — numeric literal (int, float, hex, binary, exp)
//   'string'    — short string  "..." / '...'   (value = decoded would-be content; raw kept)
//   'longstring'— [[...]] / [=*[...]=*]
//   'backtick'  — Luau `...{expr}...` interpolated string
//   'comment'   — -- line or --[[ ]] long comment
//   'punct'     — any operator / punctuation (one or two chars)
//   'eof'       — end marker
//
// Every token carries { type, value, start, end, line } where value is the RAW
// source slice [start, end). String-type tokens additionally carry `quote`
// (for short strings) or `level` (for long strings/comments).

class Lexer {
    constructor() {
        this.src = '';
        this.pos = 0;
        this.line = 1;
    }

    /**
     * Tokenize `source` into a flat array of tokens (no 'eof' appended unless
     * `withEof` is true). Never throws on malformed input — an unterminated
     * literal simply consumes to end-of-source and is emitted as-is.
     */
    tokenize(source, withEof = false) {
        this.src = source;
        this.pos = 0;
        this.line = 1;

        const tokens = [];
        const len = source.length;

        while (this.pos < len) {
            const c = source[this.pos];

            // Newline / whitespace — tracked for line numbers, not emitted.
            if (c === '\n') { this.line++; this.pos++; continue; }
            if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
                this.pos++;
                continue;
            }

            const start = this.pos;
            const line = this.line;

            // ── Comments (line or long) ──────────────────────────────
            if (c === '-' && source[this.pos + 1] === '-') {
                tokens.push(this._readComment(start, line));
                continue;
            }

            // ── Long string  [[ ]] / [=*[ ]=*] ───────────────────────
            if (c === '[') {
                const level = this._longBracketLevel(this.pos + 1);
                if (level >= 0) {
                    tokens.push(this._readLongString(start, line, level));
                    continue;
                }
            }

            // ── Backtick interpolated string (Luau) ──────────────────
            if (c === '`') {
                tokens.push(this._readBacktick(start, line));
                continue;
            }

            // ── Short string ─────────────────────────────────────────
            if (c === '"' || c === "'") {
                tokens.push(this._readShortString(start, line, c));
                continue;
            }

            // ── Number ───────────────────────────────────────────────
            if (this._isDigit(c) || (c === '.' && this._isDigit(source[this.pos + 1]))) {
                tokens.push(this._readNumber(start, line));
                continue;
            }

            // ── Name / keyword ───────────────────────────────────────
            if (this._isNameStart(c)) {
                while (this.pos < len && this._isNameChar(source[this.pos])) this.pos++;
                const value = source.substring(start, this.pos);
                tokens.push({
                    type: KEYWORDS.has(value) ? 'keyword' : 'name',
                    value, start, end: this.pos, line,
                });
                continue;
            }

            // ── Punctuation / operators (greedy 3 → 2 → 1) ───────────
            tokens.push(this._readPunct(start, line));
        }

        if (withEof) {
            tokens.push({ type: 'eof', value: '', start: len, end: len, line: this.line });
        }
        return tokens;
    }

    // ── Sub-readers ──────────────────────────────────────────────────

    _readComment(start, line) {
        const src = this.src;
        const len = src.length;
        this.pos += 2; // skip --

        // Long comment --[=*[ ... ]=*]
        if (src[this.pos] === '[') {
            const level = this._longBracketLevel(this.pos + 1);
            if (level >= 0) {
                this._consumeLongBody(level);
                return { type: 'comment', value: src.substring(start, this.pos), start, end: this.pos, line, level };
            }
        }

        // Line comment — to end of line (newline not consumed)
        while (this.pos < len && src[this.pos] !== '\n') this.pos++;
        return { type: 'comment', value: src.substring(start, this.pos), start, end: this.pos, line, level: -1 };
    }

    _readLongString(start, line, level) {
        const src = this.src;
        this.pos += 2 + level; // skip opening [=*[
        this._consumeLongBody(level);
        return { type: 'longstring', value: src.substring(start, this.pos), start, end: this.pos, line, level };
    }

    // Advance past a long-bracket body whose opener used `level` equals signs.
    // Assumes this.pos is positioned just after the opening bracket. Tracks lines.
    _consumeLongBody(level) {
        const src = this.src;
        const len = src.length;
        const closer = ']' + '='.repeat(level) + ']';
        const end = src.indexOf(closer, this.pos);
        const stop = end >= 0 ? end + closer.length : len;
        for (let i = this.pos; i < stop; i++) if (src[i] === '\n') this.line++;
        this.pos = stop;
    }

    _readShortString(start, line, quote) {
        const src = this.src;
        const len = src.length;
        this.pos++; // opening quote
        while (this.pos < len) {
            const ch = src[this.pos];
            if (ch === '\\') { this.pos += 2; continue; }     // skip escaped char
            if (ch === '\n') break;                            // unterminated
            this.pos++;
            if (ch === quote) break;                           // closed
        }
        return { type: 'string', value: src.substring(start, this.pos), start, end: this.pos, line, quote };
    }

    _readBacktick(start, line) {
        const src = this.src;
        const len = src.length;
        this.pos++; // opening backtick
        let depth = 0; // brace depth inside {expr}
        while (this.pos < len) {
            const ch = src[this.pos];
            if (ch === '\\') { this.pos += 2; continue; }
            if (ch === '\n') this.line++;
            if (ch === '{') depth++;
            else if (ch === '}') { if (depth > 0) depth--; }
            else if (ch === '`' && depth === 0) { this.pos++; break; }
            this.pos++;
        }
        return { type: 'backtick', value: src.substring(start, this.pos), start, end: this.pos, line };
    }

    _readNumber(start, line) {
        const src = this.src;
        const len = src.length;
        if (src[this.pos] === '0' && (src[this.pos + 1] === 'x' || src[this.pos + 1] === 'X')) {
            this.pos += 2;
            while (this.pos < len && /[0-9a-fA-F_]/.test(src[this.pos])) this.pos++;
        } else if (src[this.pos] === '0' && (src[this.pos + 1] === 'b' || src[this.pos + 1] === 'B')) {
            this.pos += 2;
            while (this.pos < len && /[01_]/.test(src[this.pos])) this.pos++;
        } else {
            while (this.pos < len && /[0-9_.]/.test(src[this.pos])) this.pos++;
            if (this.pos < len && (src[this.pos] === 'e' || src[this.pos] === 'E')) {
                this.pos++;
                if (src[this.pos] === '+' || src[this.pos] === '-') this.pos++;
                while (this.pos < len && /[0-9]/.test(src[this.pos])) this.pos++;
            }
        }
        return { type: 'number', value: src.substring(start, this.pos), start, end: this.pos, line };
    }

    _readPunct(start, line) {
        const src = this.src;
        // Longest-match multi-char operators first.
        const three = src.substr(start, 3);
        const two = src.substr(start, 2);
        const THREE = new Set(['...']);
        const TWO = new Set(['==', '~=', '<=', '>=', '..', '::', '//',
            '+=', '-=', '*=', '/=', '%=', '^=', '..=']);
        if (THREE.has(three) || three === '..=') { this.pos += 3; return { type: 'punct', value: three, start, end: this.pos, line }; }
        if (TWO.has(two)) { this.pos += 2; return { type: 'punct', value: two, start, end: this.pos, line }; }
        this.pos += 1;
        return { type: 'punct', value: src[start], start, end: this.pos, line };
    }

    // ── Helpers ──────────────────────────────────────────────────────

    // At `pos` (just after a '['), count '=' run then require a following '['.
    // Returns the level (>=0) for a valid long-bracket opener, else -1.
    _longBracketLevel(pos) {
        const src = this.src;
        let count = 0;
        while (pos < src.length && src[pos] === '=') { count++; pos++; }
        return (pos < src.length && src[pos] === '[') ? count : -1;
    }

    _isDigit(c) { return c >= '0' && c <= '9'; }
    _isNameStart(c) { return c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
    _isNameChar(c) { return this._isNameStart(c) || this._isDigit(c); }
}

// ── Convenience exports ──────────────────────────────────────────────

/** Tokenize and return the token array (no eof). */
function tokenize(source) {
    return new Lexer().tokenize(source);
}

/**
 * Decode the textual VALUE of a short/long/backtick string token (escape
 * sequences resolved, surrounding delimiters removed). Returns the inner JS
 * string. Backtick interpolations are returned with `{...}` left verbatim.
 */
function stringValue(token) {
    if (token.type === 'longstring') {
        const m = /^\[(=*)\[/.exec(token.value);
        const level = m ? m[1].length : 0;
        let inner = token.value.slice(2 + level, token.value.length - (2 + level));
        // Lua strips a leading newline in long strings.
        if (inner.charCodeAt(0) === 0x0A) inner = inner.slice(1);
        else if (inner.charCodeAt(0) === 0x0D) inner = inner.charCodeAt(1) === 0x0A ? inner.slice(2) : inner.slice(1);
        return inner;
    }
    if (token.type === 'string') {
        return decodeShort(token.value.slice(1, -1));
    }
    if (token.type === 'backtick') {
        return decodeShort(token.value.slice(1, -1));
    }
    return token.value;
}

// Resolve Lua escape sequences in a short-string body.
function decodeShort(body) {
    let out = '';
    let i = 0;
    const len = body.length;
    const SIMPLE = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
    while (i < len) {
        const c = body[i];
        if (c !== '\\') { out += c; i++; continue; }
        const e = body[i + 1];
        if (e === undefined) { out += '\\'; i++; continue; }
        if (SIMPLE[e] !== undefined) { out += SIMPLE[e]; i += 2; continue; }
        if (e === 'z') { i += 2; while (i < len && /\s/.test(body[i])) i++; continue; }
        if (e === 'x') { const code = parseInt(body.substr(i + 2, 2), 16); out += isNaN(code) ? '' : String.fromCharCode(code); i += 4; continue; }
        if (e === 'u' && body[i + 2] === '{') {
            let j = i + 3; while (j < len && body[j] !== '}') j++;
            const code = parseInt(body.substring(i + 3, j), 16);
            out += isNaN(code) ? '' : String.fromCodePoint(code);
            i = j + 1; continue;
        }
        if (e >= '0' && e <= '9') {
            let d = e; let k = i + 2;
            while (k < len && d.length < 3 && body[k] >= '0' && body[k] <= '9') { d += body[k]; k++; }
            out += String.fromCharCode(parseInt(d, 10) & 0xFF);
            i = k; continue;
        }
        out += e; i += 2;
    }
    return out;
}

module.exports = { Lexer, tokenize, stringValue, KEYWORDS };
