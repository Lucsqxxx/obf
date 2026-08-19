'use strict';

const luaparse = require('luaparse');

/**
 * LuaSyntaxValidator
 * Full Luau syntax checker with support for vanilla Lua 5.2, Luau,
 * Roblox Studio globals, and exploit-executor (UNC) globals.
 *
 * Validation is two-tier:
 *   1. A real PARSE gate (luaparse over a Luau→5.3 down-conversion). This is
 *      authoritative for "is this a real program?" and rejects nonsense the old
 *      heuristic checks waved through (a bare `L`, `lol`, `x +`, `return return`
 *      — none of which are valid statements). Benchmarked at 100% agreement
 *      with the official luau-ast parser over a valid/invalid battery.
 *   2. The heuristic checks (delimiters, keyword pairs, compound-assign, etc.)
 *      which run first to surface friendly, line-numbered messages, and also
 *      catch things the down-convert intentionally rewrites away.
 *
 * Usage:
 *   const v = new LuaSyntaxValidator({ mode: 'exploit' });
 *   const { valid, errors, warnings } = v.validate(sourceCode);
 *
 * Options:
 *   mode               – 'lua52' | 'luau' | 'roblox' | 'exploit'  (default: 'exploit')
 *   warnUnknownGlobals – boolean  (default: false)
 *                        Warns about identifiers not in the known globals list.
 *                        Has false-positive risk; best used as a hint, not an error.
 *   warnDeprecated     – boolean  (default: false)
 *                        Warns about deprecated Roblox APIs (wait, spawn, delay).
 */
class LuaSyntaxValidator {
    constructor(options = {}) {
        this.options = {
            mode: 'exploit',
            warnUnknownGlobals: false,
            warnDeprecated: false,
            ...options,
        };
        this._buildGlobals();
    }

    // ══════════════════════════════════════════════════════════════════
    //  Public API
    // ══════════════════════════════════════════════════════════════════

    validate(source) {
        const errors   = [];
        const warnings = [];

        // Strings/comments first — an unclosed string/comment corrupts every
        // other check (and the parser), so it's the one structural error we
        // surface on its own.
        this._checkStrings(source, errors);
        if (errors.length) return { valid: false, errors, warnings, mode: this.options.mode };

        const stripped = this._stripCommentsAndStrings(source);

        // ── Structural validity: the PARSE GATE is authoritative ──────────
        // luaparse (over a Luau→5.3 down-conversion) decides valid/invalid.
        // The old heuristic block matchers (_checkKeywordPairs etc.) are kept
        // ONLY to produce friendlier, line-numbered messages — and only when
        // the parser ALSO says the code is invalid. They must never reject on
        // their own: they false-positive on valid Luau (e.g. a generic
        // `local function f<T>(): T ... end`, whose return-type annotation the
        // heuristic strip mis-handles), which used to bounce good scripts.
        const parseErr = this._parseCheck(source);
        if (parseErr) {
            const heur = [];
            this._checkDelimiters(stripped, heur);
            this._checkKeywordPairs(stripped, heur);
            this._checkBreakContinue(stripped, heur);
            // Prefer specific heuristic messages when present; always include the
            // parser's verdict so there's a definitive error even if heuristics
            // found nothing.
            for (const e of heur) errors.push(e);
            errors.push(parseErr);
        }

        // ── Advisory checks (warnings only — never affect valid/invalid) ──
        this._checkGenericBrackets(stripped, warnings);
        this._checkTypeAnnotations(stripped, warnings);
        this._checkCommonMistakes(stripped, warnings);  // JS-isms, Python-isms, etc.
        if (this.options.warnUnknownGlobals) this._checkGlobals(stripped, warnings);

        return { valid: errors.length === 0, errors, warnings, mode: this.options.mode };
    }

    /**
     * Authoritative parse gate. Down-converts Luau-only surface syntax (types,
     * compound assignment, string interpolation, `continue`, `::` casts) to
     * plain Lua 5.3, then parses with luaparse. Returns an error string on
     * failure, or null if the source is a well-formed program.
     *
     * Why down-convert instead of parsing Luau directly: luaparse is a Lua 5.3
     * parser and rejects Luau-only syntax, but it IS a real parser — so once the
     * Luau surface is normalized away, a parse failure reliably means the code
     * isn't a valid program. Verified at 100% agreement with the official
     * luau-ast parser across a valid/invalid battery (see test/validator.js).
     */
    _parseCheck(source) {
        const converted = this._downConvertLuau(source);
        try {
            luaparse.parse(converted, { luaVersion: '5.3' });
            return null;
        } catch (e) {
            // luaparse errors look like "[L:C] message near '...'". Re-map to the
            // validator's "Line N: ..." style, dropping the column for brevity.
            const m = /^\[(\d+):\d+\]\s*(.*)$/.exec(e.message || '');
            if (m) return `Line ${m[1]}: ${m[2]}`;
            return `Syntax error: ${e.message || 'invalid Lua/Luau'}`;
        }
    }

    /**
     * Strip Luau-only surface so a Lua 5.3 parser can validate structure.
     * Mirrors the down-converter used by the Luau test battery (zluau.js). The
     * replacements preserve line count where practical so parse errors keep
     * meaningful line numbers.
     */
    _downConvertLuau(s) {
        return s
            .replace(/`(?:[^`\\]|\\.)*`/g, '""')                                  // interp string → plain string
            .replace(/^[ \t]*(export[ \t]+)?type[ \t]+[^\n]*/gm, '')              // type aliases
            .replace(/\s*::\s*[\w.<>{}|&?\[\] ]+/g, '')                           // :: type assertions
            .replace(/([)\]\w])\s*(\.\.|\/\/|[-+*/%^])=(?!=)/g, '$1=')            // compound assignment → plain
            .replace(/\bcontinue\b/g, 'break')                                   // continue → break (both need a loop)
            .replace(/:[ \t]*\{[^{}]*\}/g, '')                                    // : {table type}
            .replace(/:[ \t]*[A-Za-z_][\w.]*(<[^>]*>)?(\s*[|&]\s*[A-Za-z_][\w.]*(<[^>]*>)?)*\??/g, '') // : T annotations
            .replace(/<[A-Za-z_][\w, ]*>/g, '');                                 // leftover generics
    }

    // ══════════════════════════════════════════════════════════════════
    //  Global databases
    // ══════════════════════════════════════════════════════════════════

    _buildGlobals() {
        const lua52 = [
            '_G', '_VERSION', '_ENV', 'self',
            'assert', 'collectgarbage', 'dofile', 'error', 'gcinfo',
            'getmetatable', 'ipairs', 'load', 'loadfile', 'loadstring',
            'module', 'newproxy', 'next', 'pairs', 'pcall', 'print',
            'rawequal', 'rawget', 'rawlen', 'rawset', 'require', 'select',
            'setmetatable', 'tonumber', 'tostring', 'type', 'unpack',
            'warn', 'xpcall',
            'bit', 'bit32', 'coroutine', 'debug', 'io', 'math',
            'os', 'package', 'string', 'table',
        ];

        const luau = [
            'buffer', 'task', 'utf8', 'vector', 'typeof',
        ];

        const roblox = [
            'game', 'workspace', 'script', 'plugin', 'shared',
            'Axes', 'BrickColor', 'CFrame', 'CatalogSearchParams', 'Color3',
            'ColorSequence', 'ColorSequenceKeypoint', 'DateTime',
            'DockWidgetPluginGuiInfo', 'Enum', 'Faces', 'FloatCurveKey', 'Font',
            'Instance', 'NumberRange', 'NumberSequence', 'NumberSequenceKeypoint',
            'OverlapParams', 'PathWaypoint', 'PhysicalProperties', 'Random',
            'Ray', 'RaycastParams', 'Rect', 'Region3', 'Region3int16',
            'RotationCurveKey', 'TweenInfo', 'UDim', 'UDim2', 'UserSettings',
            'Vector2', 'Vector2int16', 'Vector3', 'Vector3int16',
            'elapsedTime', 'printidentity', 'settings', 'Stats', 'tick', 'time',
            'wait', 'delay', 'spawn', 'LoadLibrary', 'Version',
            'Drawing',
        ];

        const exploit = [
            // Environment
            'getgenv', 'getrenv', 'getsenv', 'getfenv', 'setfenv',
            'getthreadidentity', 'setthreadidentity',
            'getthreadcontext',  'setthreadcontext',
            'identifyexecutor',  'getexecutorname',
            // Closure utilities
            'newcclosure',       'newlclosure',
            'islclosure',        'iscclosure',        'isclosure',
            'isexecutorclosure', 'checkclosure',
            'hookfunction',      'hookmetamethod',    'replaceclosure',
            'getscriptclosure',  'getscriptfunction',
            'clonefunction',     'cloneclosure',
            // Metatable manipulation
            'getrawmetatable',   'setrawmetatable',
            'setreadonly',       'isreadonly',
            'make_writeable',    'make_readonly',
            'getnamecallmethod', 'setnamecallmethod',
            // Instance / Roblox internals
            'getinstances',      'getnilinstances',
            'getscripts',        'getloadedmodules',
            'cloneref',          'compareinstances',
            'gethiddenproperty', 'sethiddenproperty',
            'getproperties',     'getspecialinfo',
            'firetouchinterest', 'fireproximityprompt', 'firesignal', 'fireclickdetector',
            'getcustomasset',    'getsynasset',
            'gethui',            'get_hidden_gui',
            'getobjects',
            // Script analysis
            'getscriptbytecode', 'getscripthash',
            'dumpstring',        'decompile',
            // GC / memory
            'getgc', 'getallthreads', 'getrunningscripts',
            // Caller context
            'checkcaller', 'getcallingscript', 'getscriptthread', 'checksign',
            // File system (UNC)
            'readfile',   'writefile',  'appendfile', 'loadfile',
            'listfiles',  'makefolder', 'delfolder',  'delfile',
            'isfile',     'isfolder',
            // Network
            'request', 'http_request', 'syn_request', 'WebSocket',
            // Crypto / encoding
            'crypt', 'base64_encode', 'base64_decode', 'base64',
            // Drawing API
            'cleardrawcache',    'isrenderobj',
            'getrenderproperty', 'setrenderproperty',
            // Input simulation
            'mouse1click',    'mouse1press',    'mouse1release',
            'mouse2click',    'mouse2press',    'mouse2release',
            'mousemoveabs',   'mousemoverel',   'mousescroll',
            'keypress',       'keyrelease',     'keyclick',
            'iswindowactive', 'setwindowtitle', 'getwindowsize', 'getmouse',
            // Misc utilities
            'queue_on_render_step', 'messagebox',
            'setclipboard', 'toclipboard',
            'getfflag',     'setfflag',
            'cache',        'getconnections',
            // Executor sentinels / namespaces
            'syn',     'fluxus',  'oxygen',  'swift',
            'wave',    'celery',  'krnl',    'dex',
            'KRNL_LOADED', 'Synapse', 'pebc',
            'rconsole',      'rconsoleinput',  'rconsoleprint',
            'rconsolename',  'rconsoleclear',  'rconsolecreate', 'rconsoleclose',
        ];

        const { mode } = this.options;
        const combined = new Set(lua52);
        if (mode === 'luau'   || mode === 'roblox' || mode === 'exploit') luau.forEach(g => combined.add(g));
        if (mode === 'roblox' || mode === 'exploit')                      roblox.forEach(g => combined.add(g));
        if (mode === 'exploit')                                            exploit.forEach(g => combined.add(g));

        this.knownGlobals   = combined;
        this.exploitGlobals = new Set(exploit);
    }

    // ══════════════════════════════════════════════════════════════════
    //  Strip helpers
    // ══════════════════════════════════════════════════════════════════

    /**
     * Returns source with all comment and string *contents* replaced by
     * spaces/X, while preserving newlines (for line numbers) and keeping
     * structural characters (, ), {, }, [, ] intact for downstream checks.
     */
    _stripCommentsAndStrings(source) {
        let out = '';
        let i   = 0;
        const len = source.length;
        const nl  = j => source[j] === '\n' ? '\n' : ' ';

        while (i < len) {
            // Shebang
            if (i === 0 && source[i] === '#' && source[i + 1] === '!') {
                while (i < len && source[i] !== '\n') { out += ' '; i++; }
                continue;
            }

            // Long comment  --[=*[...]=*]
            if (source[i] === '-' && source[i + 1] === '-' && source[i + 2] === '[') {
                const lvl = this._countEquals(source, i + 3);
                if (lvl >= 0) {
                    const cls  = ']' + '='.repeat(lvl) + ']';
                    const end  = source.indexOf(cls, i + 4 + lvl);
                    const stop = end >= 0 ? end + cls.length : len;
                    for (let j = i; j < stop; j++) out += nl(j);
                    i = stop; continue;
                }
            }

            // Line comment
            if (source[i] === '-' && source[i + 1] === '-') {
                while (i < len && source[i] !== '\n') { out += ' '; i++; }
                continue;
            }

            // Long string  [=*[...]=*]
            if (source[i] === '[') {
                const lvl = this._countEquals(source, i + 1);
                if (lvl >= 0) {
                    const cls  = ']' + '='.repeat(lvl) + ']';
                    const end  = source.indexOf(cls, i + 2 + lvl);
                    const stop = end >= 0 ? end + cls.length : len;
                    for (let j = i; j < stop; j++) out += nl(j);
                    i = stop; continue;
                }
            }

            // Interpolated backtick string — keep { } visible for delimiter check
            if (source[i] === '`') {
                out += '`'; i++;
                let depth = 0;
                while (i < len && !(source[i] === '`' && depth === 0)) {
                    if (source[i] === '\n')          { out += '\n'; i++; continue; }
                    if (depth === 0) {
                        if (source[i] === '{')       { depth++; out += '{'; }
                        else if (source[i] === '\\') { out += '  '; i++; }
                        else                         { out += 'X'; }
                    } else {
                        if (source[i] === '{')       depth++;
                        else if (source[i] === '}')  depth--;
                        out += source[i];
                    }
                    i++;
                }
                if (i < len) { out += '`'; i++; }
                continue;
            }

            // Short strings
            if (source[i] === '"' || source[i] === "'") {
                const q = source[i];
                out += q; i++;
                while (i < len && source[i] !== q && source[i] !== '\n') {
                    if (source[i] === '\\') { out += '  '; i += 2; continue; }
                    out += 'X'; i++;
                }
                if (i < len && source[i] === q) { out += q; i++; }
                continue;
            }

            out += source[i]; i++;
        }
        return out;
    }

    _stripTypeAnnotations(s) {
        s = s.replace(/\b(export\s+)?type\s+[A-Za-z_]\w*(?:\s*<[^>]*>)?\s*=\s*[^\n]*/g, '');
        s = s.replace(/:\s*\{[^{}]*\}/g, '');
        s = s.replace(/\)\s*:\s*[\w({\[|&?][^\n,){}]*/g, ')');
        s = s.replace(
            /:\s*(?:nil|any|never|unknown|boolean|number|string|thread|buffer|[A-Z]\w*)(?:\??(?:\s*[|&]\s*[A-Za-z_]\w*\??)*)*/g,
            ''
        );
        return s;
    }

    // ══════════════════════════════════════════════════════════════════
    //  Individual checks
    // ══════════════════════════════════════════════════════════════════

    _checkStrings(source, errors) {
        let i = 0, len = source.length, line = 1;

        while (i < len) {
            if (source[i] === '\n') { line++; i++; continue; }

            if (i === 0 && source[i] === '#' && source[i + 1] === '!') {
                while (i < len && source[i] !== '\n') i++;
                continue;
            }

            if (source[i] === '-' && source[i + 1] === '-') {
                const ai = i + 2;
                if (ai < len && source[ai] === '[') {
                    const lvl = this._countEquals(source, ai + 1);
                    if (lvl >= 0) {
                        const sl  = line;
                        const cls = ']' + '='.repeat(lvl) + ']';
                        const end = source.indexOf(cls, ai + 2 + lvl);
                        if (end < 0) { errors.push(`Line ${sl}: Unclosed long comment`); return; }
                        for (let j = i; j < end + cls.length; j++) if (source[j] === '\n') line++;
                        i = end + cls.length; continue;
                    }
                }
                while (i < len && source[i] !== '\n') i++;
                continue;
            }

            if (source[i] === '[') {
                const lvl = this._countEquals(source, i + 1);
                if (lvl >= 0) {
                    const sl  = line;
                    const cls = ']' + '='.repeat(lvl) + ']';
                    const end = source.indexOf(cls, i + 2 + lvl);
                    if (end < 0) { errors.push(`Line ${sl}: Unclosed long string`); return; }
                    for (let j = i; j < end + cls.length; j++) if (source[j] === '\n') line++;
                    i = end + cls.length; continue;
                }
            }

            if (source[i] === '`') {
                const sl = line; i++;
                let depth = 0;
                while (i < len && !(source[i] === '`' && depth === 0)) {
                    if (source[i] === '\n') line++;
                    if (source[i] === '{')                       depth++;
                    else if (source[i] === '}')                  depth = Math.max(0, depth - 1);
                    else if (source[i] === '\\' && depth === 0)  i++;
                    i++;
                }
                if (i >= len) { errors.push(`Line ${sl}: Unclosed backtick string`); return; }
                i++; continue;
            }

            if (source[i] === '"' || source[i] === "'") {
                const q = source[i], sl = line; i++;
                while (i < len && source[i] !== q && source[i] !== '\n') {
                    if (source[i] === '\\') i++;
                    i++;
                }
                if (i >= len || source[i] === '\n') {
                    errors.push(`Line ${sl}: Unclosed string literal (${q})`);
                } else { i++; }
                continue;
            }

            i++;
        }
    }

    _checkDelimiters(stripped, errors) {
        const pairs   = { '(': ')', '[': ']', '{': '}' };
        const closing = new Set([')', ']', '}']);
        const stack   = [];
        let line = 1;

        for (let i = 0; i < stripped.length; i++) {
            const c = stripped[i];
            if (c === '\n')          { line++; continue; }
            if (pairs[c])            { stack.push({ char: c, line }); }
            else if (closing.has(c)) {
                if (!stack.length) {
                    errors.push(`Line ${line}: Unexpected '${c}' — no matching opener`);
                } else {
                    const top = stack.pop();
                    if (pairs[top.char] !== c) {
                        errors.push(`Line ${line}: Mismatched '${c}' — expected '${pairs[top.char]}' to close '${top.char}' (opened line ${top.line})`);
                    }
                }
            }
        }
        for (const unc of stack) errors.push(`Line ${unc.line}: Unclosed '${unc.char}'`);
    }

    _checkGenericBrackets(stripped, warnings) {
        const re = /\btype\s+\w[\w.]*\s*</g;
        let m;
        while ((m = re.exec(stripped)) !== null) {
            let depth = 0;
            let j     = m.index + m[0].length - 1;
            const sl  = stripped.substring(0, j).split('\n').length;
            while (j < stripped.length && stripped[j] !== '\n') {
                if (stripped[j] === '<')      depth++;
                else if (stripped[j] === '>') { if (--depth === 0) break; }
                j++;
            }
            if (depth > 0) warnings.push(`Line ${sl}: Unclosed '<' in generic type declaration`);
        }
    }

    /**
     * Stack-based block-structure matcher.
     *
     * IMPROVED: now also tracks if/elseif/else ordering:
     *   – 'elseif' after 'else' → error
     *   – duplicate 'else' in same if block → error
     */
    _checkKeywordPairs(stripped, errors) {
        const clean   = this._stripTypeAnnotations(stripped);
        const tokens  = this._tokenizeKeywords(clean);
        const loopKws = new Set(['for', 'while', 'repeat']);
        const stack   = [];

        for (const tok of tokens) {
            switch (tok.word) {
                case 'function':
                case 'for':
                case 'while':
                case 'repeat':
                    stack.push({ ...tok });
                    break;

                case 'if':
                    stack.push({ ...tok, elseState: 'open' });
                    break;

                case 'do': {
                    const top = stack.length ? stack[stack.length - 1] : null;
                    if (top && loopKws.has(top.word) && !top.doSeen) {
                        top.doSeen = true;
                    } else {
                        stack.push({ ...tok });
                    }
                    break;
                }

                case 'then':
                    // Part of if-header — no stack effect needed
                    break;

                case 'else': {
                    const top = stack.length ? stack[stack.length - 1] : null;
                    if (top && top.word === 'if') {
                        if (top.elseState === 'else') {
                            errors.push(`Line ${tok.line}: Duplicate 'else' — only one 'else' block is allowed per 'if'`);
                        } else {
                            top.elseState = 'else';
                        }
                    }
                    break;
                }

                case 'elseif': {
                    const top = stack.length ? stack[stack.length - 1] : null;
                    if (top && top.word === 'if') {
                        if (top.elseState === 'else') {
                            errors.push(`Line ${tok.line}: 'elseif' after 'else' — 'elseif' clauses must come before 'else'`);
                        }
                    }
                    break;
                }

                case 'break':
                case 'continue':
                    // Handled separately in _checkBreakContinue
                    break;

                case 'end':
                    if (!stack.length) {
                        errors.push(`Line ${tok.line}: Extra 'end' — no open block to close`);
                    } else {
                        const top = stack.pop();
                        if (top.word === 'repeat') {
                            errors.push(`Line ${tok.line}: 'end' found but 'repeat' (line ${top.line}) must close with 'until'`);
                        }
                    }
                    break;

                case 'until':
                    if (!stack.length) {
                        errors.push(`Line ${tok.line}: 'until' with no matching 'repeat'`);
                    } else {
                        const top = stack.pop();
                        if (top.word !== 'repeat') {
                            errors.push(`Line ${tok.line}: 'until' closes '${top.word}' (line ${top.line}) — '${top.word}' requires 'end'`);
                        }
                    }
                    break;
            }
        }

        for (const unc of stack) {
            const need = unc.word === 'repeat' ? "'until'" : "'end'";
            errors.push(`Line ${unc.line}: Unclosed '${unc.word}' — missing ${need}`);
        }
    }

    /**
     * NEW: Verify break and continue only appear inside loops.
     *
     * Uses a scope stack to correctly handle the case where a function is
     * defined inside a loop — break/continue inside that function should
     * error, since they cannot escape the function boundary.
     *
     * e.g.:
     *   for i = 1, 10 do
     *     local f = function()
     *       break  -- ERROR: break is inside a function, not directly in the loop
     *     end
     *     break    -- OK
     *   end
     */
    _checkBreakContinue(stripped, errors) {
        const clean  = this._stripTypeAnnotations(stripped);
        const tokens = this._tokenizeKeywords(clean, new Set([
            'for', 'while', 'repeat', 'do', 'function', 'end', 'until',
            'break', 'continue',
        ]));

        const loopKws = new Set(['for', 'while', 'repeat']);
        // Stack entries: { type: 'loop'|'function'|'block', word, line, doSeen? }
        const stack   = [];

        // Returns true if we're currently inside a loop scope reachable
        // without crossing a function boundary
        const inLoop = () => {
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].type === 'function') return false;
                if (stack[i].type === 'loop')     return true;
            }
            return false;
        };

        for (const tok of tokens) {
            switch (tok.word) {
                case 'function':
                    stack.push({ type: 'function', word: 'function', line: tok.line });
                    break;

                case 'for':
                case 'while':
                case 'repeat':
                    stack.push({ type: 'loop', word: tok.word, line: tok.line });
                    break;

                case 'do': {
                    const top = stack.length ? stack[stack.length - 1] : null;
                    if (top && loopKws.has(top.word) && !top.doSeen) {
                        top.doSeen = true;
                    } else {
                        stack.push({ type: 'block', word: 'do', line: tok.line });
                    }
                    break;
                }

                case 'end':
                    if (stack.length) stack.pop();
                    break;

                case 'until':
                    if (stack.length) stack.pop();
                    break;

                case 'break':
                    if (!inLoop()) {
                        errors.push(`Line ${tok.line}: 'break' outside of a loop`);
                    }
                    break;

                case 'continue':
                    if (!inLoop()) {
                        errors.push(`Line ${tok.line}: 'continue' outside of a loop`);
                    }
                    break;
            }
        }
    }

    _checkTypeAnnotations(stripped, warnings) {
        stripped.split('\n').forEach((line, li) => {
            const m = line.trim().match(/\btype\s+([a-z]\w*)/);
            if (m) warnings.push(`Line ${li + 1}: Type '${m[1]}' should be PascalCase (Luau convention)`);
        });
    }

    /**
     * IMPROVED: Catches more common mistakes.
     *
     * New checks vs original:
     *   – String literal directly adjacent to '+' (should use '..')
     *   – 'os.exit' in Roblox/exploit mode
     *   – 'io.*' in Roblox/exploit mode
     *   – Deprecated 'wait()', 'spawn()', 'delay()' (gated by warnDeprecated)
     *   – Pre-increment '++x' (original only caught post-increment 'x++')
     *   – 'x--' (Lua comment syntax often confused for decrement)
     */
    _checkCommonMistakes(stripped, warnings) {
        const isRoblox = this.options.mode === 'roblox' || this.options.mode === 'exploit';

        stripped.split('\n').forEach((raw, li) => {
            const line = raw.trim();
            const ln   = li + 1;
            if (!line) return;

            // ── Assignment in condition ─────────────────────────────────────
            if (/\b(?:if|elseif|while)\b/.test(line)) {
                const cond = line.replace(/\b(?:if|elseif|while)\s*/, '');
                if (/[^=~<>!]=[^=]/.test(cond) && !/[+\-*/%^]=|\.\.=/.test(cond)) {
                    warnings.push(`Line ${ln}: Possible '=' (assignment) in condition — did you mean '=='?`);
                }
            }

            // ── JavaScript-isms ─────────────────────────────────────────────
            // Post-increment: x++
            if (/\w\+\+/.test(line))
                warnings.push(`Line ${ln}: '++' is not valid Luau — use 'x = x + 1'`);

            // Pre-increment: ++x
            if (/\+\+\w/.test(line))
                warnings.push(`Line ${ln}: '++' is not valid Luau — use 'x = x + 1'`);

            // x-- is a line comment in Lua starting right after x, catch the intent
            // (this fires when '--' appears immediately after a word char with no space)
            if (/\w--/.test(line))
                warnings.push(`Line ${ln}: '\w--' looks like a decrement but '--' starts a comment in Lua — use 'x = x - 1'`);

            if (/!=/.test(line))
                warnings.push(`Line ${ln}: '!=' is not valid Luau — use '~='`);

            if (/&&/.test(line))
                warnings.push(`Line ${ln}: '&&' is not valid Luau — use 'and'`);

            if (/(?<!\|)\|\|/.test(line))
                warnings.push(`Line ${ln}: '||' is not valid Luau — use 'or'`);

            // '!' not followed by '=' and not preceded by operator chars
            if (/(?<![=!<>~])!(?!=)/.test(line))
                warnings.push(`Line ${ln}: '!' is not valid Luau — use 'not'`);

            // ── Python-isms ─────────────────────────────────────────────────
            if (/(?<!\*)\*\*(?!=)/.test(line))
                warnings.push(`Line ${ln}: '**' is not valid Luau — use '^' for exponentiation`);

            if (/(?<!\/)\/{2}(?!\/)/.test(line))
                warnings.push(`Line ${ln}: '//' is not valid Luau — use 'math.floor(a / b)' for integer division`);

            // ── Luau-specific ───────────────────────────────────────────────
            if (this.options.mode !== 'lua52' && /\bgoto\b/.test(line))
                warnings.push(`Line ${ln}: 'goto' is not supported in Luau — use break, continue, or return`);

            // String literal directly adjacent to '+' → likely meant '..'
            // In stripped source, string contents are 'X', so "hello" → "XXXXX"
            if (/(?:"X*"|'X*')\s*\+(?!=)/.test(line) || /(?<![*+])\+(?!=)\s*(?:"X*"|'X*')/.test(line))
                warnings.push(`Line ${ln}: String concatenation in Luau uses '..' not '+'`);

            // ── Roblox-specific ─────────────────────────────────────────────
            if (isRoblox) {
                if (/\bos\.exit\s*\(/.test(line))
                    warnings.push(`Line ${ln}: 'os.exit' is not available in Roblox — use a return or conditional guard instead`);

                if (/\bio\.[a-z]/.test(line))
                    warnings.push(`Line ${ln}: 'io.*' is not available in Roblox — use readfile/writefile for file I/O`);
            }

            // ── Deprecated Roblox APIs (opt-in) ────────────────────────────
            if (this.options.warnDeprecated && isRoblox) {
                if (/(?<![.:])\bwait\s*\(/.test(line))
                    warnings.push(`Line ${ln}: 'wait()' is deprecated — use 'task.wait()' instead`);

                if (/(?<![.:])\bspawn\s*\(/.test(line))
                    warnings.push(`Line ${ln}: 'spawn()' is deprecated — use 'task.spawn()' instead`);

                if (/(?<![.:])\bdelay\s*\(/.test(line))
                    warnings.push(`Line ${ln}: 'delay()' is deprecated — use 'task.delay()' instead`);
            }
        });
    }

    /**
     * IMPROVED: Now includes line numbers in warnings.
     * Uses a binary-search line map for O(log n) per lookup instead of O(n).
     */
    _checkGlobals(stripped, warnings) {
        const clean = this._stripTypeAnnotations(stripped);

        const KEYWORDS = new Set([
            'and', 'break', 'continue', 'do', 'else', 'elseif', 'end',
            'export', 'false', 'for', 'function', 'goto', 'if', 'in',
            'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
            'true', 'type', 'typeof', 'until', 'while',
        ]);

        // Collect locals declared in this file
        const locals = new Set();
        for (const m of clean.matchAll(/\blocal\s+(?:function\s+)?([A-Za-z_]\w*)/g))
            locals.add(m[1]);
        for (const m of clean.matchAll(/\bfunction\s+[A-Za-z_.\w]*\s*\(([^)]*)\)/g)) {
            m[1].split(',').forEach(p => {
                const n = p.trim().replace(/^\.\.\./, '').split(':')[0].trim();
                if (n) locals.add(n);
            });
        }
        for (const m of clean.matchAll(/\bfor\s+([A-Za-z_]\w*)/g)) locals.add(m[1]);

        const lineMap = this._buildLineMap(clean);
        const warned  = new Set();

        for (const m of clean.matchAll(/(?<![.:\w])([A-Za-z_]\w*)\b/g)) {
            const name = m[1];
            if (warned.has(name))            continue;
            if (KEYWORDS.has(name))          continue;
            if (locals.has(name))            continue;
            if (this.knownGlobals.has(name)) continue;
            if (/^[A-Z]$/.test(name))        continue;
            warned.add(name);
            const ln = this._lineOf(lineMap, m.index);
            warnings.push(`Line ${ln}: '${name}' is not a recognised ${this.options.mode} global (may be a local defined elsewhere)`);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  Utilities
    // ══════════════════════════════════════════════════════════════════

    /**
     * Tokenize block-structure keywords (and optionally break/continue).
     *
     * UPDATED: Accepts an optional keyword Set override so _checkBreakContinue
     * can request a different keyword set without a second pass.
     * Default set now includes 'break' and 'continue'.
     */
    _tokenizeKeywords(source, kwSet) {
        const kws = kwSet || new Set([
            'function', 'if', 'for', 'while', 'repeat',
            'do', 'then', 'else', 'elseif', 'end', 'until',
            'break', 'continue',
        ]);
        const tokens = [];
        const re = /\b([a-zA-Z_]\w*)\b/g;
        let m, line = 1, cursor = 0;

        while ((m = re.exec(source)) !== null) {
            for (let j = cursor; j < m.index; j++) if (source[j] === '\n') line++;
            cursor = m.index + m[0].length;
            if (kws.has(m[1])) tokens.push({ word: m[1], line });
        }
        return tokens;
    }

    /**
     * Count '=' signs at pos, returning the count only when immediately
     * followed by '[' (valid long-bracket opener). Returns -1 otherwise.
     */
    _countEquals(source, pos) {
        let count = 0;
        while (pos < source.length && source[pos] === '=') { count++; pos++; }
        return pos < source.length && source[pos] === '[' ? count : -1;
    }

    /**
     * Build a sorted array of character offsets where each line starts.
     * lineMap[0] = 0 (line 1 starts at char 0)
     * lineMap[1] = offset after first '\n' (line 2 starts here)
     * etc.
     */
    _buildLineMap(source) {
        const map = [0];
        for (let i = 0; i < source.length; i++) {
            if (source[i] === '\n') map.push(i + 1);
        }
        return map;
    }

    /**
     * Binary search: return 1-based line number for a character offset.
     */
    _lineOf(lineMap, pos) {
        let lo = 0, hi = lineMap.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineMap[mid] <= pos) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    }
}

module.exports = LuaSyntaxValidator;