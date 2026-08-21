// ═══════════════════════════════════════════════════════════════
//  UmbraX — Bot helpers
//
//  Pure, side-effect-free utilities shared across command handlers:
//  flag parsing, byte formatting, progress bars, protection tiers,
//  input resolution (code arg vs file attachment), and error embeds.
//  Kept dependency-light so they're unit-testable without a live client.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { C, FOOTER, BRAND, LAYER_FLAGS, MAX_FILE_SIZE, VALID_EXTS } = require('./constants');

// Split opt-in obfuscation-layer flags out of the argument list. Returns the
// selected `layers` (transformer option keys) and `args` with the flags removed
// (so they aren't mistaken for inline code). Case-insensitive.
function parseLayerFlags(args) {
    const layers = {};
    const rest = [];
    for (const a of (args || [])) {
        const key = LAYER_FLAGS.get(a.toLowerCase());
        if (key) layers[key] = true;
        else rest.push(a);
    }
    return { layers, args: rest };
}

// Human-readable byte size.
function formatBytes(bytes) {
    if (bytes < 1024)    return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(2)} MB`;
}

// A █/░ progress bar of `len` cells representing value/max (clamped).
function bar(value, max, len = 10) {
    const filled = Math.round((value / max) * len);
    return '█'.repeat(Math.min(filled, len)) + '░'.repeat(Math.max(0, len - filled));
}

// Map output size → a protection "tier" label used in the result embed.
function protectionLevel(size) {
    if (size > 50000) return { label: 'MAXIMUM',  emoji: '🔴', color: C.error   };
    if (size > 30000) return { label: 'EXTREME',  emoji: '🟠', color: C.orange  };
    if (size > 20000) return { label: 'HIGH',     emoji: '🟡', color: C.warn    };
    return               { label: 'STANDARD', emoji: '🟢', color: C.success };
}

// Format an uptime duration (ms) as a compact d/h/m/s string.
function uptime(ms) {
    const s = Math.floor(ms /    1000) % 60;
    const m = Math.floor(ms /   60000) % 60;
    const h = Math.floor(ms / 3600000) % 24;
    const d = Math.floor(ms / 86400000);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
}

// Named colors + the shared palette, so staff can type `color: purple`.
const NAMED_COLORS = {
    purple: C.main, green: C.success, red: C.error, blue: C.info,
    yellow: C.warn, orange: C.orange, cyan: C.cyan, pink: C.pink,
};

// Resolve a color token: #hex, 0x hex, bare hex, or a named color. Returns a
// number or null (caller falls back to its own default).
// Shared by .embed and the giveaway builder so the accepted tokens never drift.
function parseColor(tok) {
    if (!tok) return null;
    const t = String(tok).trim().toLowerCase();
    if (NAMED_COLORS[t] !== undefined) return NAMED_COLORS[t];
    const hex = t.replace(/^#/, '').replace(/^0x/, '');
    if (/^[0-9a-f]{6}$/.test(hex)) return parseInt(hex, 16);
    return null;
}

// Only http(s) URLs are accepted for image/thumbnail so a typo doesn't throw
// inside EmbedBuilder.
function isHttpUrl(s) {
    return /^https?:\/\/\S+$/i.test(String(s || '').trim());
}

// Parse a compact duration ("30s", "10m", "2h", "1d") into milliseconds.
// Returns null on anything unrecognised so callers can report a usage error.
// Shared by moderation (.timeout) and giveaways so the two never drift.
function parseDuration(str) {
    if (!str) return null;
    const m = /^(\d+)\s*(s|m|h|d)$/i.exec(str.trim());
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!n) return null;
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
    return n * unit;
}

// Render a duration (ms) as a friendly phrase like "2 hours" or "1 day 3 hours"
// for confirmation messages. Falls back to the compact uptime() shape for odd
// values. Only the two largest non-zero units are shown to stay readable.
function humanizeDuration(ms) {
    if (!ms || ms < 1000) return '0 seconds';
    const units = [
        ['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000],
    ];
    const parts = [];
    let rem = ms;
    for (const [name, size] of units) {
        const v = Math.floor(rem / size);
        if (v > 0) { parts.push(`${v} ${name}${v === 1 ? '' : 's'}`); rem -= v * size; }
        if (parts.length === 2) break;
    }
    return parts.join(' ');
}

// Resolve the source code for a command: inline text after the command, or an
// attached .lua/.luau/.txt file (downloaded). Returns { source, fileName } or
// { error } — never throws. Validation branches (missing input, bad extension,
// oversize, download failure) are all reported as { error }.
async function fetchSource(message, args) {
    const file = message.attachments?.first?.() ?? null;
    const code = reconstructInline(message, args);

    if (!file && !code) {
        return { error: 'Provide either code after the command or a `.lua`/`.luau`/`.txt` file attachment.' };
    }

    if (file) {
        const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
        if (!VALID_EXTS.has(ext)) {
            return { error: 'Only `.lua`, `.luau`, and `.txt` files are accepted.' };
        }
        if (file.size > MAX_FILE_SIZE) {
            return { error: `Maximum file size is **${formatBytes(MAX_FILE_SIZE)}**.` };
        }
        try {
            const resp = await fetch(file.url);
            if (!resp.ok) return { error: `Failed to download file (HTTP ${resp.status}).` };
            return { source: await resp.text(), fileName: file.name };
        } catch (err) {
            return { error: `Failed to download file: ${err.message}` };
        }
    }

    return { source: code };
}

/**
 * Rebuild inline (pasted) code from the RAW message content so newlines survive.
 *
 * Why this exists: the dispatcher tokenizes with `content.split(/\s+/)`, which
 * collapses every newline in a pasted multi-line script. Rejoining those tokens
 * with single spaces (the old `args.join(' ')`) folds the whole script onto one
 * line — and if it starts with a `--` comment, ALL following lines slide into
 * that comment, so the syntax validator parses an empty program and waves broken
 * code straight through (the "0 strings" symptom). Reconstructing from
 * `message.content` keeps the line breaks, so the validator sees the real script.
 *
 * We drop the leading `<prefix><command>` token, then peel any leading
 * layer-flag / `hwid:` tokens (the switches the callers strip out of `args`),
 * and return the remainder verbatim. Falls back to `args.join(' ')` when no raw
 * content is available (e.g. unit tests that call the helper directly).
 */
function reconstructInline(message, args) {
    const content = typeof message?.content === 'string' ? message.content : '';
    if (content) {
        let rest = content.replace(/^\s*\S+[ \t]*/, '');   // strip "<prefix><command>"
        let m;
        // Peel leading layer-flag / hwid tokens (the switches callers pull out of
        // `args`). The separator may be a newline, and the final flag may have no
        // trailing separator at all (flags-only message), so match either.
        while ((m = /^(\S+)(\s+|$)/.exec(rest))) {
            const tok = m[1];
            if (LAYER_FLAGS.has(tok.toLowerCase()) || /^hwid:/i.test(tok)) {
                rest = rest.slice(m[0].length);
            } else break;
        }
        if (rest.trim().length) return rest;
    }
    return args && args.length ? args.join(' ') : '';
}

// Best-effort: mirror a moderation/management action to the configured
// mod-log channel (config.modLogChannelId). No-op if unset or unreachable —
// this is an audit convenience, never something a command should fail over.
async function sendModLog(client, config, embed) {
    if (!config?.modLogChannelId) return;
    const channel = await client.channels.fetch(config.modLogChannelId).catch(() => null);
    if (channel && typeof channel.send === 'function') await channel.send({ embeds: [embed] }).catch(() => {});
}

// A standard red error embed.
function errorEmbed(title, desc) {
    return new EmbedBuilder()
        .setColor(C.error)
        .setTitle(`\`❌\` ${title}`)
        .setDescription(desc)
        .setFooter(FOOTER)
        .setTimestamp();
}

// Can this member use the obfuscator commands? Access is granted when:
//   • no role is configured (open to everyone), OR
//   • the member has the configured role, OR
//   • the member is a server administrator / the guild owner (always allowed).
// DMs (no guild member) are treated as no-access when a role is configured.
function hasObfuscatorAccess(message, roleId) {
    if (!roleId) return true;                       // gating disabled
    const member = message.member;
    if (!member) return false;                      // DM / uncached — deny
    if (member.id === message.guild?.ownerId) return true;
    if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;
    return member.roles?.cache?.has?.(roleId) ?? false;
}

// Red "you can't use this" embed shown when the obfuscator role is missing.
function accessDeniedEmbed(roleId) {
    return new EmbedBuilder()
        .setColor(C.error)
        .setAuthor({ name: BRAND })
        .setTitle('`🔒` Access Restricted')
        .setDescription(
            `The obfuscator is limited to members with the <@&${roleId}> role.\n` +
            'Ask a staff member if you think you should have access.',
        )
        .setFooter(FOOTER)
        .setTimestamp();
}

// Can this member use the staff-only management commands (.update, .embed,
// .ticket setup)? Access is granted when the member is the guild owner, an
// administrator, holds the configured manager role, or — if no manager role is
// configured — holds the Discord "Manage Server" permission (sensible default
// so the commands are usable before a role is set up). DMs are always denied.
function hasStaffAccess(message, roleId) {
    const member = message.member;
    if (!member) return false;                      // DM / uncached — deny
    if (member.id === message.guild?.ownerId) return true;
    if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;
    if (roleId) return member.roles?.cache?.has?.(roleId) ?? false;
    // No role configured → fall back to a Discord permission so it still works.
    return member.permissions?.has?.(PermissionsBitField.Flags.ManageGuild) ?? false;
}

// Red "staff only" embed shown when a management command is used without access.
function staffAccessDeniedEmbed(roleId) {
    return new EmbedBuilder()
        .setColor(C.error)
        .setAuthor({ name: BRAND })
        .setTitle('`🔒` Staff Only')
        .setDescription(
            roleId
                ? `This command is limited to <@&${roleId}> and server staff.`
                : 'This command requires the **Manage Server** permission.',
        )
        .setFooter(FOOTER)
        .setTimestamp();
}

module.exports = {
    parseLayerFlags, formatBytes, bar, protectionLevel, uptime,
    parseDuration, humanizeDuration, parseColor, isHttpUrl, NAMED_COLORS,
    fetchSource, errorEmbed, hasObfuscatorAccess, accessDeniedEmbed,
    hasStaffAccess, staffAccessDeniedEmbed, sendModLog,
};
