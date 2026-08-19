// ═══════════════════════════════════════════════════════════════
//  UmbraX — .update command (staff only)
//
//  Recreates the product "update announcement" card (see the reference
//  image): a version line, a "reopen to receive the latest update"
//  prompt, and a monospace changelog block. Staff paste the version on
//  the first line and one changelog entry per following line; the bot
//  reposts it as a clean embed and deletes the invoking message so the
//  channel shows only the announcement.
//
//  The first line is the version. Optional directives may follow the version
//  on that same line: `#channel` to post elsewhere, and `noping` to suppress
//  the role ping. Everything after the first line is the changelog.
//
//  Usage:
//    .update v0.0.2 #announcements
//    - Fixed excessive RAM usage while injected
//    - Fixed crashes with several saveinstance scripts
//    Note: Luarmor support will be added later
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, FOOTER } = require('../constants');
const { errorEmbed } = require('../helpers');
const config = require('../config');

// Discord embed description hard limit is 4096; the changelog goes inside a
// fenced block so leave generous headroom for the fences + version lines.
const MAX_BODY = 3500;

// Compose the announcement embed from its parts (version + changelog body).
// Shared by the text path and the interactive builder so both render
// identically. Always produces a non-empty embed for the live preview.
function buildUpdateEmbed({ version, body }) {
    const product = config.productName || 'UmbraX';
    const v = version || 'v0.0.0';
    const parts = [
        `Version **${v}** is now out!`,
        '',
        `Reopen **${product}** to receive the latest update`,
    ];
    if (body) parts.push('', "**What's new:**", '```' + '\n' + body + '\n' + '```');

    return new EmbedBuilder()
        .setColor(C.success)
        .setTitle(`${product} has been updated`)
        .setDescription(parts.join('\n'))
        .setFooter({ text: `${v} • ${FOOTER.text}` })
        .setTimestamp();
}

// ── Interactive builder spec ─────────────────────────────────────
function updateBuilderSpec() {
    return {
        kind: 'update',
        title: 'Update Announcement',
        accent: C.success,
        channelTarget: true,
        fields: [
            { key: 'version', label: 'Version',   kind: 'short',     max: 64,   placeholder: 'v0.0.2', required: true },
            { key: 'body',    label: 'Changelog', kind: 'paragraph', max: MAX_BODY, placeholder: '- Fixed excessive RAM usage\n- Fixed saveinstance crashes' },
        ],
        toggles: [
            { key: 'ping', label: 'Ping', initial: true, onText: '🔔 Ping role: On', offText: '🔕 Ping role: Off' },
        ],
        buildPreview(v) {
            return buildUpdateEmbed({ version: v.version, body: v.body });
        },
        previewContent(v, t) {
            // Mirror the real ping so staff see whether the role gets notified.
            return (t.ping && config.supportRoleId) ? `<@&${config.supportRoleId}>` : undefined;
        },
        validate(v) {
            if (!v.version) return 'Add a version (e.g. `v0.0.2`) before posting.';
            if (v.body && v.body.length > MAX_BODY) return `Changelog too long (${v.body.length}/${MAX_BODY}).`;
            return null;
        },
        async submit({ values, toggles, targetChannel }) {
            const embed = buildUpdateEmbed({ version: values.version, body: (values.body || '').trim() });
            const pingRole = (toggles.ping && config.supportRoleId) ? config.supportRoleId : null;
            await targetChannel.send({
                content: pingRole ? `<@&${pingRole}>` : undefined,
                embeds: [embed],
                allowedMentions: pingRole ? { roles: [pingRole] } : { parse: [] },
            });
            return `Update **${values.version}** announced in ${targetChannel}.`;
        },
    };
}

function createUpdateHandler(deps = {}) {
    const { builder } = deps;
    return async function handleUpdate(message) {
        // Everything after ".update " — preserve newlines the user typed.
        const raw = message.content.slice(message.content.indexOf('update') + 'update'.length).trim();
        if (!raw) {
            // No args → open the interactive live-preview builder when available.
            if (builder) return builder.start(message, updateBuilderSpec());
            return message.reply({
                embeds: [errorEmbed(
                    'Nothing to Announce',
                    [
                        'Provide a version on the first line, then one changelog entry per line.',
                        '',
                        '**Example:**',
                        '```',
                        '.update v0.0.2',
                        '- Fixed excessive RAM usage while injected',
                        '- Fixed several saveinstance crashes',
                        'Note: more fixes coming soon',
                        '```',
                    ].join('\n'),
                )],
            });
        }

        const lines    = raw.split('\n');
        let versionLine = lines.shift().trim();
        const body     = lines.join('\n').trim();

        // Pull optional directives off the version line: a #channel / <#id>
        // target and a `noping` flag. Whatever remains is the version string.
        let targetChannel = message.channel;
        const chanMatch = versionLine.match(/<#(\d{5,})>|#(\S+)/);
        if (chanMatch) {
            const byId = chanMatch[1] && message.guild?.channels?.cache?.get(chanMatch[1]);
            const byName = !byId && chanMatch[2] && message.guild?.channels?.cache?.find(c => c.name === chanMatch[2] && typeof c.send === 'function');
            const ch = byId || byName;
            if (ch && typeof ch.send === 'function') targetChannel = ch;
            versionLine = versionLine.replace(chanMatch[0], '').trim();
        }
        const noPing = /(^|\s)noping(\s|$)/i.test(versionLine);
        const version = versionLine.replace(/(^|\s)noping(\s|$)/i, ' ').trim();

        if (body.length > MAX_BODY) {
            return message.reply({
                embeds: [errorEmbed('Changelog Too Long', `Keep the changelog under **${MAX_BODY}** characters (got ${body.length}).`)],
            });
        }

        // Same composer the interactive builder uses, so both render identically.
        const embed = buildUpdateEmbed({ version, body });

        // Ping @Members-style: if a members/support role is configured, ping it
        // above the embed so subscribers are notified (mirrors the reference).
        // Suppress with the `noping` directive on the version line.
        const pingRole = (!noPing && config.supportRoleId) ? config.supportRoleId : null;
        const content  = pingRole ? `<@&${pingRole}>` : undefined;

        await targetChannel.send({
            content,
            embeds: [embed],
            allowedMentions: pingRole ? { roles: [pingRole] } : { parse: [] },
        });

        // Remove the command message so only the announcement remains (best-effort).
        await message.delete().catch(() => {});
    };
}

module.exports = createUpdateHandler;
