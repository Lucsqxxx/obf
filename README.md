
# A obfuscator

A Discord bot that obfuscates Luau/Lua scripts and wraps them in a
self-decrypting, anti-tampered loader. Token-based pipeline (string
encryption, local renaming, number encoding, junk code) plus opt-in
stronger layers (control-flow flattening, string splitting, recursive
number encoding, global indirection).

---

## Requirements

- **Node.js 16.11+** (discord.js v14 requirement)
- A Discord bot application + token

## Setup

**1. Install dependencies**

```powershell
npm install
```

**2. Create the bot & get a token**

- Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
- **Bot** tab → **Reset Token** → copy it.
- **Bot** tab → **Privileged Gateway Intents** → enable **Message Content Intent**
  (required — the bot reads message content for its `.`-prefix commands).
- **OAuth2 → URL Generator** → scopes `bot`, permissions *Send Messages* +
  *Attach Files* → open the generated URL to invite the bot to your server.

**3. Provide the token**

Copy the example config and fill it in:

```powershell
Copy-Item config.example.json config.json
# then edit config.json — paste your token and application (client) ID
```

`config.json` is git-ignored so your secret never gets committed.

**Preferred for production** — use an environment variable instead of a file,
so the secret never lives on disk (this takes priority over `config.json`):

```powershell
$env:DISCORD_TOKEN     = "your-token-here"
$env:DISCORD_CLIENT_ID = "your-client-id"   # optional, only needed for slash-command deploy
```

**4. Run**

```powershell
npm start
```

You should see `[UmbraX] ✓ Logged in as <bot>#0000`.

---

## Commands

Prefix: `.`  •  Accepts inline code or a `.lua` / `.luau` / `.txt` attachment (max 500 KB).

| Command | Description |
|---------|-------------|
| `.obfuscate [code \| file] [flags]` | Obfuscate + wrap in the anti-tampered loader |
| `.secure [code \| file] [flags] [hwid:<id>]` | Obfuscate + ID-lock + host on Rubis (falls back to a file if hosting is down) |
| `.encrypt <text>` | Encrypt a single string into a copy-paste Lua snippet |
| `.beautify [code \| file]` | Reformat Lua with proper indentation (native `luau_beautifier` if installed, else built-in) |
| `.minify [code \| file]` | Shrink Lua — strip whitespace/comments (native `darklua`, else `luau_beautifier --minify`) |
| `.ping` | WebSocket latency & uptime |
| `.help` | Command reference |

### Optional obfuscation flags

Add these to `.obfuscate` / `.secure` for stronger (and larger) output. All are
off by default and each is gated by the test suite:

| Flag | Effect |
|------|--------|
| `--cff` (or `--flatten`) | Control-flow flattening — top-level statements become a state-machine dispatch loop |
| `--split` (or `--splitstrings`) | Split string literals into concatenated encrypted pieces |
| `--deep` (or `--deepnumbers`) | Recursive number encoding — nested arithmetic, harder to constant-fold |
| `--indirect` (or `--indirectglobals`) | Route executor/Roblox globals (`getgenv`, `hookfunction`, …) through local aliases |

Example: `.obfuscate --cff --indirect print("hi")`

`.secure hwid:<value>` additionally binds the script to a hardware ID.

> **Note on `.secure`:** the script-ID / HWID lock is **client-side deterrence,
> not real security** — anyone who deobfuscates the delivered script can bypass
> it. For a real lock, gate delivery server-side.

---

## Tests

```powershell
npm test               # runtime-equivalence suite (fengari — Lua 5.3 VM)
npm run test:validator # rejects non-programs (L, lol, x+), accepts valid Luau
npm run test:antitamper    # anti-tamper: traps a deobfuscator, spares real users
npm run test:roblox    # runs output in a simulated executor env (game present)
npm run test:realluau  # runs output in the REAL Luau VM (see below)
npm run test:check     # inner/outer parse validity (luaparse)
npm run test:stress    # many seeds per script, reports failure rate
npm run test:luau      # Luau syntax + exploit-global coverage battery
npm run test:nativetools   # .minify/.beautify native-tool plumbing + graceful degradation
npm run test:all       # everything above, in sequence
```

### Real-Luau runtime tests

`fengari` is **Lua 5.3**, not Luau — its 64-bit integers hide double-precision
bugs that break real Roblox (a bare `a*b` that overflows 2^53 is exact in 5.3
but lossy in Luau). `test:realluau` runs the obfuscated output through the
**official Luau binary** and compares printed output to the original.

It looks for `luau` via `$LUAU_BIN`, then `PATH`, then `.luau-cache/`, and
**skips gracefully** (never fails) if none is found. To run it, grab a build
from the [Luau releases](https://github.com/luau-lang/luau/releases) and:

```powershell
$env:LUAU_BIN = "C:\path\to\luau.exe"
npm run test:realluau
```

---

## Optional native tools (`.minify` / `.beautify`)

`.minify` and `.beautify` can use external native binaries when present, and
**degrade gracefully** when they aren't — `.beautify` falls back to the built-in
pure-JS formatter, and `.minify` reports that no minifier is installed. Each
binary is discovered via the same ladder as the Luau binary: an explicit env
var → the bare name on `PATH` → a repo-local cache dir.

| Tool | Used by | Env var | Cache dir | Get it |
|------|---------|---------|-----------|--------|
| [darklua](https://github.com/seaofvoices/darklua) (Rust) | `.minify` (preferred) | `DARKLUA_BIN` | `.darklua-cache/` | Prebuilt binaries on the [releases page](https://github.com/seaofvoices/darklua/releases) |
| [luau_beautifier](https://github.com/TechHog8984/luau_beautifier) (C++) | `.beautify`, `.minify` fallback | `LUAU_BEAUTIFIER_BIN` | `.luaufmt-cache/` | Build with [Lune](https://lune-org.github.io) (`lune run build silent`) |

```powershell
$env:DARKLUA_BIN         = "C:\path\to\darklua.exe"
$env:LUAU_BEAUTIFIER_BIN = "C:\path\to\luau-beautifier.exe"
```

> `luau_beautifier` is upstream-deprecated in favour of
> [luau-format](https://github.com/TechHog8984/luau-format); it has no prebuilt
> Windows binary and must be compiled. The bot works without it — the native
> path is opt-in, the built-in beautifier and darklua cover the common cases.
>
> `npm run test:nativetools` covers the handler branches on every platform; the
> live executable-stub section runs on POSIX/CI and **skips on Windows** (a real
> `.exe` can't be fabricated from a shell script).

---

## Project layout

```
config.example.json  Template — copy to config.json (kept at repo root)

src/bot/                    Discord bot layer
  index.js                  Bot entry point (commands, client, login)
  deploy-commands.js        Registers slash commands with Discord
  config.js                 Token/clientId loader (env vars > config.json)
  store.js                  Cooldown + usage-stat persistence (data/state.json)
  commands/secure.js        The .secure command (ID lock + Rubis upload)
  commands/minify.js        The .minify command (darklua / luau_beautifier)

src/obfuscator/             Obfuscation core (no bot/Discord dependency)
  transformer.js            Obfuscation orchestrator (token-based pipeline)
  engine.js                 String cipher (CFB stream) + Lua decrypt-stub emitter
  loader.js                 Whole-script self-decrypting loader/packer
  antitamper.js             Hook/sandbox/debugger detection + integrity guards
  lexer.js                  Single tokenizer — source of truth for code-vs-literal
  validator.js              Standalone Lua syntax checker
  beautifier.js             Lua pretty-printer (.beautify)
  nativetools.js            Crash-proof wrappers for optional darklua / luau_beautifier binaries

test/                       All test + harness code
  run / validator /         npm-scripted suites
    antitamper / roblox /
    luau-real
  check / stress / luau     parse / stress / Luau-syntax harnesses (were z*.js)
  fixtures / lua-runtime    shared test helpers
```

---

*Made by Lucsqx.*
=======
# obf
>>>>>>> 42b0dd418785355fb21576103ae3051379f52667
