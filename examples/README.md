# UmbraX obfuscation example

- **`obfuscated-demo.input.lua`** — the original, human-readable Luau source.
- **`obfuscated-demo.lua`** — the same script after running through the full
  UmbraX pipeline: string encryption **hoisted into an index-derived-key string
  pool** (no inline per-string keys) + **magnitude-tiered number encoding**
  (deep) + **scope-aware local rename** (shadowed/disjoint locals get distinct
  names) + **opaque-predicate junk** + string splitting + indirect globals +
  control-flow flattening + the self-decrypting loader with the anti-tamper
  layer.

Both produce identical output in a Roblox executor:

```
Hello, guest! Welcome to UmbraX.
sum of 2*(1..10) = 110
```

## How it was generated

```js
const Transformer = require('../src/obfuscator/transformer');
const t = new Transformer();
const out = t.transform(input, {
  seed:            20260724,   // reproducible build (seedable PRNG)
  renameVariables: true,
  addJunkCode:     true,
  encodeNumbers:   true,
  deepNumbers:     true,       // recursive number encoding
  minStringLength: 1,
  watermark:       true,
  splitStrings:    true,
  stringPool:      true,       // hoist ciphertext into a shuffled, index-keyed pool
  indirectGlobals: true,
  controlFlow:     true,
});
```

> All layers are stable across builds and preserve behaviour: the checked-in
> output was verified to run and print identical results to the original in both
> the fengari executor sim (`test/roblox.js`) and the official **luau** binary
> (`test/luau-real.js`), the double-precision authority. The whole suite
> (`npm run test:all`) is green with every layer above enabled.
