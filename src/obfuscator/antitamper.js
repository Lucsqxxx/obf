// ═══════════════════════════════════════════════════════════════
//  UmbraX — Anti-Tamper (anti-deobfuscation traps)
//
//  These guards exist to make the output hostile to someone DEOBFUSCATING it:
//  on a strong tamper/instrumentation signal the script hangs forever
//  (`task.wait(9e9)`), so a naive automated deobfuscator that runs the loader
//  in an emulated/hooked environment wedges instead of dumping the payload.
//  Every lethal bomb is gated on `_E.game`, so a benign offline run (game nil,
//  as in local tests) is never bricked.
//
//  The traps come in two flavours, split by ONE rule: can the signal tell a
//  deobfuscator apart from a normal user?
//
//    LETHAL (hang on trip) — signals only a deobfuscator/analysis VM produces:
//      • sandbox suite   — trips on a THRESHOLD of failed probes (faithful
//                          executors fail ~0; an instrumented sandbox fails
//                          many). One flaky probe can't brick a real executor.
//      • payload hash    — the decrypted payload was actually altered.
//      • opaque predicate— a dead branch a static analyser can't fold away.
//
//    NON-LETHAL (detect, never halt) — the hook guard. It counts executor
//      globals (hookfunction, getrawmetatable, …), but ≥5 of those existing is
//      NORMAL — they're the API every executor exposes and the user's script
//      calls. It cannot distinguish a deobfuscator from a normal user, so it
//      must never hang (the old design did, and bricked EVERY real executor).
//      It still emits its counting noise for static-analysis friction.
//
//  Emitted Lua uses the `_E` placeholder for the environment table; the
//  loader replaces /\b_E\b/ with the real polymorphic env alias after join.
//
//  All generators take the loader's polymorphic name set `v` (which must
//  provide: sn, p, stR, a, fs) plus a `rand()` name factory and, for the
//  hook guard, the loader's `encStr` string-obfuscation helper.
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { rng, randInt } = require('./rng');
const defaultRand = () => require('./rng').rname(2, 7);

// A random, plausible-but-nonexistent identifier for the probes that deliberately
// reference a name that must NOT exist on a real Roblox object (calling a bogus
// method, looking up a bogus child/class). A faithful executor returns nil / errors
// so the probe passes; an instrumented VM that answers everything truthily trips it.
// Randomized PER BUILD so the fake names that used to brand every UmbraX output in
// plaintext (`__subgmaballshaha__`, `__DefinitelyFake__`, `__definitely_not_real__`,
// the `umbrax`/`_umx_*` genv markers — all seen verbatim in a real deobfuscator dump)
// are no longer a static grep signature. 10+ random base36 chars cannot collide with
// a real API or child name in practice, and even a freak collision only nudges the
// failure count by 1 (bomb threshold is 4), so it can't brick a real user.
function fakeName() {
    return require('./rng').rname(2, 2 + randInt(10, 16));
}

// An "effectively forever" wait argument, VARIED per bomb. The old design emitted
// `task.wait(9e9)` verbatim in every bomb (and every decoy), giving an automated
// dumper — and any manual reverser — one literal to grep/count (a real dump bailed
// with "To much calls on `task.wait`"). The enclosing `while true` already guarantees
// the hang, so this value only sets the yield magnitude: any large finite number is
// behaviourally identical. Tests observe the `task.wait` CALL (they throw a sentinel
// from it), never its argument, so varying it is test-transparent. We keep `task.wait`
// as the yield primitive on purpose — tripping a hooked-wait dumper is the GOAL; the
// win here is denying the single static fingerprint, not hiding the call.
function hangArg() {
    const forms = [
        () => `${randInt(2, 9)}e${randInt(9, 12)}`,
        () => `0x${randInt(0x10000000, 0x7FFFFFFF).toString(16).toUpperCase()}`,
        () => `2^${randInt(40, 52)}`,
        () => `${randInt(100000000, 2100000000)}`,
    ];
    return forms[Math.floor(rng() * forms.length)]();
}

// How many sandbox probes must fail before the LETHAL bomb fires. Measured: a
// faithful executor fails 0, an instrumented deobfuscation sandbox fails ~9
// (out of ~18). 4 sits well inside that gap — a real executor would need four
// independent probes to spuriously misfire before a user is ever affected.
const SANDBOX_BOMB_THRESHOLD = 4;

// Lethal trap. Emits Lua that hangs forever when `cond` holds AND we're in a
// real Roblox env (`_E.game`). The game gate keeps benign offline runs safe.
// `cond` is any Lua boolean expression (the tamper/deobfuscation verdict).
function bombStmt(cond) {
    return `if (${cond}) and _E.game then while true do if _E.task then _E.task.wait(${hangArg()}) end end end`;
}

// Non-lethal detection sink. "Consumes" a boolean `cond` without ever halting:
// stashes the flag in getgenv() when the executor exposes it, else a throwaway
// local. The verdict is still *referenced*, so the check can't be dead-code-
// eliminated, but no branch can brick the run. Used only where the signal
// can't distinguish a deobfuscator from a normal user (the hook guard).
function sinkStmt(cond, rand = defaultRand, flagKey = fakeName()) {
    const flag = rand();
    return `do local ${flag}=${cond} if _E.getgenv then local _gv=_E.getgenv() if type(_gv)=="table" then _gv[${JSON.stringify(flagKey)}]=${flag} end else local _=${flag} end end`;
}

// ── 1. Hook-detection probe (non-lethal) ─────────────────────────
// Counts executor hook globals (static-analysis noise) and routes the verdict
// into a discarded sink. NOTE: ≥5 of these existing is NORMAL for any executor
// — they're the API the script uses — so this must never halt. The old design
// hung forever here, which bricked the output in every real executor.
function hookGuard(encStr, rand = defaultRand, flagKey = fakeName()) {
    const hookNames = ['hookfunction', 'hookmetamethod', 'getrawmetatable',
        'getnamecallmethod', 'setreadonly', 'checkcaller', 'iscclosure'];
    const hookVar = rand();
    const L = [`do local ${hookVar}=0`];
    for (const name of hookNames) {
        L.push(`if _E[${encStr(name)}]~=nil then ${hookVar}=${hookVar}+1 end`);
    }
    L.push(sinkStmt(`${hookVar}>=5`, rand, flagKey));
    L.push(`end`);
    return L;
}

// ── 2. Char-table integrity probe ────────────────────────────────
// string.byte must behave; otherwise something hooked it.
function charIntegrity(v, rand = defaultRand) {
    const intVar = rand();
    return [`do local ${intVar}=${v.p}(function() if ${v.a}("A",1)~=65 then _E.error("") end if ${v.a}("\\0",1)~=0 then _E.error("") end end) end`];
}

// ── 3. Sandbox / debugger detection suite (defines v.sn) ─────────
// Returns the Lua that DEFINES the detection function `v.sn`. Each probe
// increments a failure counter; v.sn() returns the failure COUNT (0 on a
// faithful executor). sandboxInvoke() compares it against the bomb threshold
// so a single flaky probe can't brick a real run. Early-returns 0 when there
// is no `game` (benign offline run).
function sandboxFn(v, rand = defaultRand) {
    const fl = rand();
    const chk = rand();
    const eer = rand();
    const guardKey = fakeName();
    const L = [];
    L.__probeNames = [chk, eer]; // for checkCount() introspection
    L.push(`${v.sn}=function()`);
    L.push(`if not _E.game then return 0 end`);
    L.push(`local ${fl}=0`);
    L.push(`local function ${chk}(f) local _ok,_r=${v.p}(f) if not _ok then ${fl}=${fl}+1 end end`);
    L.push(`local function ${eer}(f) local _ok=${v.p}(f) if _ok then ${fl}=${fl}+1 end end`);

    L.push(`${chk}(function() local _ld=_E.loadstring or _E.load if not _ld then return end local _ok1,_c1=${v.p}(_ld,"return pcall(function() return 1/'abc' end)") if not _ok1 or _E.type(_c1)~="function" then return end local _ok2,_pok,_pe=${v.p}(_c1) if not _ok2 or _pok~=false then _E.error("lf1") end local _l1=_E.tonumber(${v.stR}(_pe):match(":(%d+):")) local _ok3,_c2=${v.p}(_ld,"\\nreturn pcall(function() return 1/'abc' end)") if not _ok3 or _E.type(_c2)~="function" then return end local _ok4,_pok2,_pe2=${v.p}(_c2) if not _ok4 or _pok2~=false then _E.error("lf2") end local _l2=_E.tonumber(${v.stR}(_pe2):match(":(%d+):")) if _l1 and _l2 and _l2~=_l1+1 then _E.error("lf3") end end)`);
    L.push(`${chk}(function() local _inf=_E.debug and (_E.debug.getinfo or _E.debug.info) if _E.type(_inf)~="function" then return end local _r=_inf(function() return true end,"f") if _r==nil then _E.error("d1") end end)`);
    L.push(`${eer}(function() _E.task.spawn({}) end)`);
    L.push(`${eer}(function() return _E.workspace[${JSON.stringify(fakeName())}](_E.workspace) end)`);
    L.push(`${eer}(function() return _E.game[${JSON.stringify(fakeName())}](_E.game) end)`);
    L.push(`${chk}(function() if _E.game:FindFirstChild(${JSON.stringify(fakeName())}) then _E.error("g1") end end)`);
    L.push(`${chk}(function() if _E.workspace:FindFirstChildOfClass(${JSON.stringify(fakeName())}) then _E.error("g2") end end)`);
    L.push(`${chk}(function() local _ch=_E.workspace:GetChildren() local _c=#_ch local _s=${v.stR}(_c) local _n=_E.tonumber(_s) if _E.type(_c)~="number" or _E.type(_s)~="string" or _E.type(_n)~="number" then _E.error("c1") end end)`);
    L.push(`${chk}(function() local _p1=_E.Instance.new("Part") local _p2=_E.Instance.new("Part") ${v.p}(function() _p1:Destroy() end) ${v.p}(function() _p2:Destroy() end) end)`);
    L.push(`${chk}(function() if _E.type(_E.newproxy)~="function" then return end local _px=_E.newproxy(true) local _mt=_E.getmetatable(_px) if _E.type(_mt)~="table" then _E.error("px1") end _mt.__index={Name="probe"} _mt.__len=function() return 1000159 end _mt.__metatable=false if _px.Name~="probe" then _E.error("px2") end if #_px~=1000159 then _E.error("px3") end end)`);
    L.push(`${v.p}(function() local _genv=_E.getgenv and _E.getgenv() if _E.type(_genv)=="table" then _genv[${JSON.stringify(fakeName())}]=true end end)`);
    L.push(`${chk}(function() if not _E.os or not _E.os.clock then return end local _t1=_E.os.clock() local _s=0 for _qi=1,1000 do _s=_s+_qi end local _t2=_E.os.clock() if (_t2-_t1)>2 then _E.error("tm") end end)`);
    L.push(`${chk}(function() if not _E.debug or not _E.debug.traceback then return end local _tb=_E.debug.traceback("",1) if _E.type(_tb)~="string" then _E.error("st1") end if #_tb<1 then _E.error("st2") end end)`);
    L.push(`${chk}(function() local _g1=_E.game local _g2=_E.game if _E.rawequal and not _E.rawequal(_g1,_g2) then _E.error("ei") end end)`);
    L.push(`${chk}(function() local _di=_E.debug and _E.debug.info if not _di then return end local _tp=${v.p}(function() local _src=_di(_E.pcall,"s") if _E.type(_src)=="string" and #_src>0 and _src~="[C]" then _E.error("ft1") end end) end)`);
    L.push(`${chk}(function() local _genv=_E.getgenv and _E.getgenv() if _E.type(_genv)~="table" then return end if _genv["${guardKey}"] then _E.error("dx") end _genv["${guardKey}"]=true end)`);
    L.push(`${chk}(function() local _co=_E.coroutine.wrap(function() return 42 end) local _r=_co() if _r~=42 then _E.error("co1") end local _ok=_E.pcall(_co) end)`);
    L.push(`${chk}(function() if _E.tostring(nil)~="nil" then _E.error("tc1") end if _E.tonumber("1")~=1 then _E.error("tc2") end if _E.type(true)~="boolean" then _E.error("tc3") end if _E.type("")~="string" then _E.error("tc4") end end)`);
    L.push(`return ${fl}`);
    L.push(`end`);
    return L;
}

// ── 4. Invoke the sandbox detector (LETHAL, thresholded) ─────────
// Hang only when the failed-probe count meets the bomb threshold. A faithful
// executor fails ~0 probes and sails through; an instrumented/emulated
// deobfuscation environment fails many and wedges.
//
// `failExpr` is a Lua expression yielding the failure count. The loader passes
// the name of a variable it already captured from a SINGLE `v.sn()` call (so
// the probe suite — which has genv side-effects and a dedup guard — runs once,
// and the same verdict both key-gates the cipher and arms this bomb). When
// omitted it falls back to calling `v.sn()` inline (legacy behaviour).
function sandboxInvoke(v, failExpr) {
    return [bombStmt(`${failExpr || `${v.sn}()`}>=${SANDBOX_BOMB_THRESHOLD}`)];
}

// ── 5. Opaque-predicate guard (LETHAL) ───────────────────────────
// `_vA*2+1` is always odd, so the band check can NEVER fail on a faithful run
// — but a static analyser can't trivially prove the branch is dead, so it must
// account for the hang. Safe to keep lethal: it has no false-positive path.
function opaqueGuard() {
    const oA = Math.floor(rng() * 1000) + 500;
    return [`do local _vA=${oA} local _vB=_vA*2+1 ${bombStmt(`_E.bit32.band(_vB,1)~=1`)} end`];
}

// ── 5b. Decoy guards (LOOK lethal, can NEVER trip) ───────────────
// A reverser who finds "the" anti-tamper bomb neutralizes it and moves on. So
// we bury the real bombs among decoys that are byte-pattern-identical — same
// `_E.game`-gated `task.wait(9e9)` via bombStmt — but whose condition is
// PROVABLY always false, so a decoy can never actually hang a run. The reverser
// can't tell a decoy from a real guard by shape; they have to reason about each
// predicate. Cheap noise, real friction, zero brick risk.
//
// Every predicate below is false on ANY deterministic Lua VM (Luau doubles,
// Lua 5.3 ints, fengari) WITHOUT relying on cross-language arithmetic agreement
// or on any hookable primitive's behavior — so a decoy cannot false-positive.
// These are NOT counted by checkCount(): they aren't real checks.
function decoyGuards(v, count = null, rand = defaultRand) {
    const n = count == null ? randInt(2, 4) : count;
    const L = [];
    for (let i = 0; i < n; i++) {
        const fam = i % 3;
        if (fam === 0) {
            // Parity: b = a*2+1 is always odd, so band(b,1) is always 1.
            const a = rand(), b = rand();
            const k = randInt(500, 5000);
            L.push(`do local ${a}=${k} local ${b}=${a}*2+1 ${bombStmt(`_E.bit32.band(${b},1)~=1`)} end`);
        } else if (fam === 1) {
            // Gauss: sum(1..K) always equals K*(K+1)/2. K<=1000 → both < 2^53,
            // exact in doubles, so the loop sum and the emitted literal agree on
            // every VM. `s` never differs from the constant.
            const s = rand(), ii = rand();
            const K = randInt(50, 1000);
            const closed = (K * (K + 1)) / 2;
            L.push(`do local ${s}=0 for ${ii}=1,${K} do ${s}=${s}+${ii} end ${bombStmt(`${s}~=${closed}`)} end`);
        } else {
            // Length: #literal is fixed and cannot be hooked. ASCII-only body, so
            // byte length == the emitted constant.
            const str = rand(), lit = require('./rng').rname(2, 2 + randInt(6, 16));
            L.push(`do local ${str}=${JSON.stringify(lit)} ${bombStmt(`#${str}~=${lit.length}`)} end`);
        }
    }
    return L;
}

// ── 6. Payload integrity hash (djb2 over the decrypted payload) ──
// Hash over UTF-8 BYTES, not JS code units. The emitted Lua guard iterates
// `#_fs` with `string.byte` (see payloadHashGuard), which walks the payload one
// BYTE at a time. `str.charCodeAt(i)` walks JS UTF-16 code units, so any
// non-ASCII byte (e.g. an em-dash in a comment → 3 UTF-8 bytes vs 1 JS unit)
// made the two hashes diverge and spuriously fired the payload-hash bomb. The
// loader already encrypts the payload as `Buffer.from(script,'utf8')`, so bytes
// are the correct, VM-matching unit here too.
// `seed` is the djb2 initial value. The textbook constant 5381 was emitted
// verbatim in every build (`local _ih=5381 …`), a static grep signature a
// dumper could key on to locate the integrity bomb. It's now RANDOMIZED per
// build and threaded identically into both this JS hasher and the emitted Lua
// (see payloadHashGuard) — djb2 self-matches for ANY initial value, so the
// guard's semantics are unchanged; only the fingerprint is gone. Defaults to
// 5381 so any legacy caller that omits the seed still round-trips.
function computePayloadHash(str, seed = 5381) {
    const bytes = Buffer.from(str, 'utf8');
    let h = seed >>> 0;
    for (let i = 0; i < bytes.length; i++) h = (((h << 5) >>> 0) + h + bytes[i]) >>> 0;
    return h;
}
function payloadHashGuard(v, payloadHashValue, seed = 5381) {
    // LETHAL: recomputes djb2 over the reconstructed payload; hangs if it was
    // altered. No false-positive path — a clean payload always matches — so
    // keeping it lethal only ever bites someone who patched the bytes.
    //
    // Signedness-robust compare: some VMs return band(...,0xFFFFFFFF) as a
    // SIGNED 32-bit int (e.g. -334867332) rather than unsigned (3960099964),
    // which would make `_ih ~= <unsigned constant>` spuriously true. The
    // injected constant is always unsigned-positive, so normalizing the Lua
    // side to a non-negative residue mod 2^32 makes the two comparable on any
    // VM (a no-op where band already returns unsigned). A DECIMAL 4294967296 is
    // used deliberately — the hex form 0x100000000 wraps to 0 on 32-bit-hex VMs.
    return [`do local _ih=${seed >>> 0} for _qi=1,#${v.fs} do _ih=bit32.band(bit32.lshift(_ih,5)+_ih+${v.a}(${v.fs},_qi),0xFFFFFFFF) end ${bombStmt(`_ih%4294967296~=${payloadHashValue}`)} end`];
}

// ── 7. Environment integrity guard (standalone inner-script block) ─
// Hashes a set of globals at load; if a deferred re-hash differs, spins.
// Emitted into the INNER (decrypted) script, so it uses bare globals.
function envIntegrityGuard(rand = defaultRand) {
    const envHash = rand();
    const checker = rand();
    const salt = randInt(10000, 99999);
    const globals = ['pcall', 'type', 'tostring', 'tonumber', 'select', 'pairs',
        'ipairs', 'next', 'rawget', 'rawset', 'setmetatable', 'getmetatable'];
    let code = 'do ';
    code += `local function ${checker}() local _h=${salt} `;
    for (const g of globals) {
        code += `if type(${g})=="function" then _h=bit32.bxor(bit32.lrotate(_h,3),${randInt(1, 0xFFFF)}) else _h=bit32.bxor(_h,${randInt(1, 0xFFFF)}) end `;
    }
    code += `return _h end local ${envHash}=${checker}() `;
    code += `pcall(function() if task and task.defer then task.defer(function() local _new=${checker}() if _new~=${envHash} then for _i=1,${randInt(50, 200)} do pcall(function() error(string.rep("\\0",${randInt(100, 500)})) end) end end end) end end) end `;
    return code;
}

// ── Honest check count ───────────────────────────────────────────
// Counts the REAL anti-tamper checks emitted, by introspecting the
// generated Lua instead of hardcoding a number. Includes: each sandbox
// probe (chk/eer call), the hook guard, char integrity, opaque guard,
// payload hash guard, and the env integrity guard.
function checkCount() {
    const v = { sn: '_sn', p: '_p', stR: '_s', a: '_a', fs: '_fs' };
    const L = sandboxFn(v);
    const [chk, eer] = L.__probeNames;
    // Each sandbox probe is a line that begins with a chk(... or eer(... call.
    const sandboxProbes = L.filter(l =>
        l.startsWith(`${chk}(function`) || l.startsWith(`${eer}(function`)).length;

    const hookChecks = hookGuard(s => `"${s}"`).filter(l => /~=nil then/.test(l)).length; // hook names
    const standalone = 1 /*charIntegrity*/ + 1 /*opaqueGuard*/ + 1 /*payloadHash*/ + 1 /*envIntegrity*/;

    return sandboxProbes + hookChecks + standalone;
}

module.exports = {
    hookGuard,
    charIntegrity,
    sandboxFn,
    sandboxInvoke,
    opaqueGuard,
    decoyGuards,
    payloadHashGuard,
    computePayloadHash,
    envIntegrityGuard,
    checkCount,
    fakeName,
    hangArg,
    SANDBOX_BOMB_THRESHOLD,
};
