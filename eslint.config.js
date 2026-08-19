// ═══════════════════════════════════════════════════════════════
//  UmbraX — ESLint flat config
//
//  Deliberately lean: catch real bugs (undeclared globals, unused
//  vars, unreachable code) without imposing a style the existing
//  codebase doesn't already follow. Run: npm run lint
// ═══════════════════════════════════════════════════════════════

'use strict';

const globals = {
    // Node.js CommonJS runtime
    require: 'readonly',
    module: 'writable',
    exports: 'writable',
    process: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    console: 'readonly',
    Buffer: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    fetch: 'readonly',       // Node 18+ global fetch (used by the bot)
    AbortController: 'readonly',
    URL: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
};

module.exports = [
    {
        ignores: ['node_modules/**', 'data/**', '.luau-cache/**'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals,
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-cond-assign': ['error', 'except-parens'],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-fallthrough': 'error',
            'valid-typeof': 'error',
            'use-isnan': 'error',
        },
    },
];
