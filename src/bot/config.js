// ═══════════════════════════════════════════════════════════════
//  UmbraX — Configuration loader
//
//  Resolution order (first non-empty wins):
//    1. Environment variables  DISCORD_TOKEN / DISCORD_CLIENT_ID
//    2. config.json            { "token": "...", "clientId": "..." }
//
//  Prefer environment variables in production so the secret never has to
//  live on disk. config.json is kept as a convenient local fallback and is
//  git-ignored (see .gitignore / config.example.json).
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

function loadFileConfig() {
    const file = path.join(__dirname, '..', '..', 'config.json');
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
        if (err.code === 'ENOENT') return {};      // no file — env vars only
        throw new Error(`config.json exists but could not be parsed: ${err.message}`);
    }
}

const fileConfig = loadFileConfig();

const fromEnv   = !!process.env.DISCORD_TOKEN;
const token    = process.env.DISCORD_TOKEN     || fileConfig.token    || '';
const clientId = process.env.DISCORD_CLIENT_ID || fileConfig.clientId || '';

// Role that unlocks the obfuscator commands. Optional — if left empty the
// obfuscator commands are open to everyone (useful for a private/test server).
// Prefer the role ID (survives renames); paste it from Discord with Developer
// Mode on → right-click the role → Copy Role ID.
const obfuscatorRoleId = process.env.OBFUSCATOR_ROLE_ID || fileConfig.obfuscatorRoleId || '';

// Staff/manager role that unlocks the announcement + server-management commands
// (.update, .embed, .ticket setup). These commands are HIDDEN from .help/.panel
// and refused unless the member holds this role (admins/owner always allowed).
// If left empty, the commands require the Discord "Manage Server" permission
// instead, so the bot still works before a role is configured.
const managerRoleId = process.env.MANAGER_ROLE_ID || fileConfig.managerRoleId || '';

// Category (optional) that newly-opened ticket channels are created under, and
// the role pinged / granted view access when a ticket opens (your support team).
// Both optional — without a category tickets are created at guild root; without
// a support role only staff with Manage Channels see new tickets.
const ticketCategoryId = process.env.TICKET_CATEGORY_ID || fileConfig.ticketCategoryId || '';
const supportRoleId    = process.env.SUPPORT_ROLE_ID    || fileConfig.supportRoleId    || '';

// Channel (optional) that ticket transcripts are posted to when a ticket closes.
// If left empty, no transcript is generated (the channel is simply deleted).
const ticketLogChannelId = process.env.TICKET_LOG_CHANNEL_ID || fileConfig.ticketLogChannelId || '';

// Channel that staff-application submissions are posted to for review (with
// Accept/Deny buttons). Required for `.application panel` to work — without it
// there is nowhere for submissions to go, so the panel refuses to post.
const applicationChannelId = process.env.APPLICATION_CHANNEL_ID || fileConfig.applicationChannelId || '';

// Channel (optional) that moderation actions (kick/ban/unban/timeout/warn/
// unwarn/lock/unlock/slowmode/nick) and staff-management posts (.say/.embed/
// .update) are mirrored to as an audit trail. If left empty, no log is kept
// beyond Discord's own audit log and the in-channel confirmation.
const modLogChannelId = process.env.MOD_LOG_CHANNEL_ID || fileConfig.modLogChannelId || '';

// Product name shown in the .update announcement ("<product> has been updated").
const productName = process.env.PRODUCT_NAME || fileConfig.productName || 'UmbraX';

// Reject the example placeholders outright — a common copy/paste mistake.
const PLACEHOLDERS = new Set(['YOUR_DISCORD_BOT_TOKEN_HERE', 'YOUR_DISCORD_CLIENT_ID_HERE', '']);
if (PLACEHOLDERS.has(token)) {
    throw new Error(
        'No usable Discord bot token found. Set the DISCORD_TOKEN environment variable ' +
        '(preferred in production) or replace the placeholder "token" in config.json ' +
        '(see config.example.json).'
    );
}

// In production, prefer env vars so the secret never lives on disk.
if (!fromEnv && process.env.NODE_ENV === 'production') {
    console.warn(
        '[config] ⚠ Token loaded from config.json in production. ' +
        'Prefer the DISCORD_TOKEN environment variable so the secret is not on disk.'
    );
}

module.exports = {
    token, clientId, fromEnv, obfuscatorRoleId,
    managerRoleId, ticketCategoryId, supportRoleId, ticketLogChannelId,
    applicationChannelId, modLogChannelId, productName,
};
