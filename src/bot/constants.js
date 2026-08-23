// ═══════════════════════════════════════════════════════════════
//  UmbraX — Bot constants
//  Shared config: version, limits, colors, branding, flag map.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const VERSION       = '2.0.0';
const PREFIX        = '.';
const COOLDOWN_MS   = 10_000;
// 100MB was never realistic for a Lua/Luau script and made a genuinely huge
// upload possible to accept — which, combined with every optional obfuscation
// layer, could take minutes of CPU (benchmarked: ~36s for a 5MB script with
// every heavy layer enabled). 3MB comfortably covers real-world scripts
// (even large exploit/game scripts are typically well under 1MB) while
// keeping worst-case processing time safely under transformAsync.js's
// 45s worker timeout.
const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3 MB

const VALID_EXTS = new Set(['.lua', '.luau', '.txt']);

// Embed colors.
const C = {
    main:    0x8B5CF6,
    success: 0x10B981,
    error:   0xEF4444,
    info:    0x6366F1,
    warn:    0xF59E0B,
    accent:  0xA78BFA,
    cyan:    0x06B6D4,
    pink:    0xEC4899,
    orange:  0xF97316,
};

const BRAND  = '⬛ UmbraX';
const FOOTER = { text: `UmbraX v${VERSION} • Made by Lucsqx` };

// Opt-in obfuscation-layer flags → transformer option keys. Shared by
// .obfuscate and .secure so both accept the same switches.
//   --cff      / --flatten         → control-flow flattening
//   --split    / --splitstrings    → string splitting
//   --deep     / --deepnumbers     → recursive number encoding
//   --indirect / --indirectglobals → global indirection
//   --pool     / --stringpool      → hoist encrypted strings into one table
const LAYER_FLAGS = new Map([
    ['--cff', 'controlFlow'], ['--flatten', 'controlFlow'],
    ['--split', 'splitStrings'], ['--splitstrings', 'splitStrings'],
    ['--deep', 'deepNumbers'], ['--deepnumbers', 'deepNumbers'],
    ['--indirect', 'indirectGlobals'], ['--indirectglobals', 'indirectGlobals'],
    ['--pool', 'stringPool'], ['--stringpool', 'stringPool'],
]);

module.exports = {
    VERSION, PREFIX, COOLDOWN_MS, MAX_FILE_SIZE, VALID_EXTS,
    C, BRAND, FOOTER, LAYER_FLAGS,
};
