// ═══════════════════════════════════════════════════════════════
//  UmbraX — .embed command (staff only)
//
//  A quick custom-embed builder for staff. Fields are given as
//  `key: value` pairs, one per line, so an announcement can be composed
//  in a single message and reposted as a clean embed (the invoking
//  message is deleted).
//
//  Keys (all optional): title, description/desc, color, footer, image,
//  thumbnail, author, url, field, channel, timestamp, edit. Repeat `field:`
//  for multiple inline fields — `field: Name | Value`. `\n` in a value
//  becomes a newline. With no recognised keys, the whole text is used as
//  the description.
//
//  Targeting & editing:
//    channel: #general        → post the embed in another channel
//    timestamp: on            → add a timestamp footer to the embed
//    edit: <messageId>        → edit an existing embed instead of posting
//                               (must be one of my messages in the target channel)
//
//  Usage:
//    .embed
//    title: Welcome
//    description: Read the rules and grab your roles below.
//    color: #8B5CF6
//    field: Support | Open a ticket in #support
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
// parseColor / isHttpUrl live in helpers.js so `.embed` and the giveaway
// builder accept exactly the same color tokens and URL shapes.
const { errorEmbed, parseColor, isHttpUrl, sendModLog } = require('../helpers');
const config = require('../config');

// Mirror a posted/edited embed to the mod-log channel (audit trail — the
// posted embed itself doesn't say who built it). `actor` is a User (works for
// both message.author and interaction.user, since the interactive builder's
// submit() only hands back an interaction, not the original message).
async function logEmbedAction(client, actor, targetChannel, action, jumpUrl) {
    const log = new EmbedBuilder()
        .setColor(C.info)
        .setAuthor({ name: BRAND })
        .setTitle('`📋` .embed Used')
        .setDescription([
            `> **By:** ${actor} (\`${actor.id}\`)`,
            `> **Action:** ${action} in ${targetChannel}`,
            jumpUrl ? `> [jump to message](${jumpUrl})` : null,
        ].filter(Boolean).join('\n'))
        .setFooter(FOOTER)
        .setTimestamp();
    await sendModLog(client, config, log);
}

// ── Interactive builder spec ─────────────────────────────────────
// Describes the embed builder to the shared interactive-builder module so
// `.embed` (no args) opens a live-preview composer. The same field set the
// text `key: value` path supports, minus repeatable fields (a modal can't do
// arbitrary repeats) — staff who need many fields still have the text path.
function embedBuilderSpec() {
    return {
        kind: 'embed',
        title: 'Embed Builder',
        accent: C.main,
        channelTarget: true,
        fields: [
            { key: 'title',       label: 'Title',            kind: 'short',     max: 256,  placeholder: 'Welcome' },
            { key: 'description', label: 'Description',      kind: 'paragraph', max: 4000, placeholder: 'Read the rules and grab your roles.' },
            { key: 'color',       label: 'Color (name or #hex)', kind: 'short', max: 32,   placeholder: 'purple  or  #8B5CF6' },
            { key: 'footer',      label: 'Footer',           kind: 'short',     max: 2048, placeholder: 'Leave blank for the default UmbraX footer' },
            { key: 'author',      label: 'Author',           kind: 'short',     max: 256 },
            { key: 'image',       label: 'Image URL',        kind: 'short',     max: 512,  placeholder: 'https://…' },
            { key: 'thumbnail',   label: 'Thumbnail URL',    kind: 'short',     max: 512,  placeholder: 'https://…' },
            { key: 'url',         label: 'Title URL',        kind: 'short',     max: 512,  placeholder: 'https://…' },
        ],
        groups: [
            { label: 'Content', keys: ['title', 'description', 'color', 'footer', 'author'] },
            { label: 'Media & Link', keys: ['image', 'thumbnail', 'url'] },
        ],
        toggles: [
            { key: 'timestamp', label: 'Timestamp', onText: '🕒 Timestamp: On', offText: '🕒 Timestamp: Off' },
        ],
        buildPreview(v, t) {
            return buildEmbedFromValues(v, t.timestamp);
        },
        validate(v) {
            if (!v.title && !v.description && !v.image && !v.author) {
                return 'Add at least a title, description, image, or author before posting.';
            }
            return null;
        },
        async submit({ values, toggles, targetChannel, interaction }) {
            const embed = buildEmbedFromValues(values, toggles.timestamp);
            const sent = await targetChannel.send({ embeds: [embed] });
            await logEmbedAction(interaction.client, interaction.user, targetChannel, 'posted', sent.url);
            return `Embed posted in ${targetChannel}.`;
        },
    };
}

// Build a finished EmbedBuilder from a flat values object (shared by the
// interactive preview/submit and available for reuse). Always renders
// something non-empty so Discord never rejects the preview.
function buildEmbedFromValues(v, withTimestamp) {
    const embed = new EmbedBuilder();
    if (v.title)  embed.setTitle(String(v.title).slice(0, 256));
    if (v.description) embed.setDescription(String(v.description).slice(0, 4096));
    if (v.author) embed.setAuthor({ name: String(v.author).slice(0, 256) });
    if (v.image && isHttpUrl(v.image)) embed.setImage(v.image.trim());
    if (v.thumbnail && isHttpUrl(v.thumbnail)) embed.setThumbnail(v.thumbnail.trim());
    if (v.url && isHttpUrl(v.url)) embed.setURL(v.url.trim());

    const c = parseColor(v.color);
    embed.setColor(c !== null ? c : C.main);
    embed.setFooter(v.footer ? { text: String(v.footer).slice(0, 2048) } : FOOTER);
    if (withTimestamp) embed.setTimestamp();

    // Guarantee a renderable body for the live preview.
    const d = embed.data;
    if (!d.title && !d.description && !d.image && !d.author && !(d.fields?.length)) {
        embed.setDescription('*Your embed preview will appear here — press* **Edit** *to add a title or description.*');
    }
    return embed;
}

function createEmbedHandler(deps = {}) {
    const { builder } = deps;
    return async function handleEmbed(message) {
        const raw = message.content.slice(message.content.indexOf('embed') + 'embed'.length).trim();
        if (!raw) {
            // No args → open the interactive live-preview builder when available.
            if (builder) return builder.start(message, embedBuilderSpec());
            return message.reply({
                embeds: [errorEmbed(
                    'Nothing to Build',
                    [
                        'Give the embed content as `key: value` lines.',
                        '',
                        '**Example:**',
                        '```',
                        '.embed',
                        'title: Welcome',
                        'description: Read the rules below.',
                        'color: purple',
                        'field: Support | Open a ticket',
                        '```',
                        '**Keys:** title, description, color, footer, image, thumbnail, author, url, field (repeatable: `Name | Value`).',
                    ].join('\n'),
                )],
            });
        }

        const embed = new EmbedBuilder();
        let colorSet = false;
        let targetChannel = message.channel;   // where to post; overridable via `channel:`
        let wantTimestamp = false;
        let editId = null;                      // message id to edit instead of send
        const descLines = [];                   // lines that weren't a recognised key:value

        const KEYS = new Set(['title', 'description', 'desc', 'color', 'colour', 'footer', 'image', 'thumbnail', 'author', 'url', 'field', 'channel', 'timestamp', 'edit']);

        for (const line of raw.split('\n')) {
            const m = /^(\w+)\s*:\s*([\s\S]*)$/.exec(line);
            const key = m && m[1].toLowerCase();
            if (!m || !KEYS.has(key)) { descLines.push(line); continue; }

            const value = m[2].replace(/\\n/g, '\n').trim();
            if (!value) continue;

            switch (key) {
                case 'channel': {
                    // Accept a <#id> mention or a raw id; must be a sendable text channel here.
                    const id = (value.match(/\d{5,}/) || [])[0];
                    const ch = id ? message.guild?.channels?.cache?.get(id) : null;
                    if (ch && typeof ch.send === 'function') targetChannel = ch;
                    break;
                }
                case 'timestamp': wantTimestamp = /^(on|yes|true|1)$/i.test(value); break;
                case 'edit': editId = (value.match(/\d{5,}/) || [])[0] || null; break;
                case 'title':       embed.setTitle(value.slice(0, 256)); break;
                case 'description':
                case 'desc':        embed.setDescription(value.slice(0, 4096)); break;
                case 'color':
                case 'colour': {
                    const c = parseColor(value);
                    if (c !== null) { embed.setColor(c); colorSet = true; }
                    break;
                }
                case 'footer':      embed.setFooter({ text: value.slice(0, 2048) }); break;
                case 'author':      embed.setAuthor({ name: value.slice(0, 256) }); break;
                case 'url':         if (isHttpUrl(value)) embed.setURL(value.trim()); break;
                case 'image':       if (isHttpUrl(value)) embed.setImage(value.trim()); break;
                case 'thumbnail':   if (isHttpUrl(value)) embed.setThumbnail(value.trim()); break;
                case 'field': {
                    const [name, ...rest] = value.split('|');
                    const fname = name.trim().slice(0, 256);
                    const fval  = rest.join('|').trim().slice(0, 1024);
                    if (fname && fval) embed.addFields({ name: fname, value: fval, inline: true });
                    break;
                }
            }
        }

        // Loose text (no key: prefix) becomes the description when none was set.
        const loose = descLines.join('\n').trim();
        if (loose && !embed.data.description) embed.setDescription(loose.slice(0, 4096));

        // Must have *something* renderable, or Discord rejects the embed.
        const d = embed.data;
        if (!d.title && !d.description && !(d.fields?.length) && !d.image && !d.author) {
            return message.reply({ embeds: [errorEmbed('Empty Embed', 'The embed had no title, description, fields, image, or author. Add at least one.')] });
        }

        if (!colorSet) embed.setColor(C.main);
        if (!d.footer) embed.setFooter(FOOTER);
        if (wantTimestamp) embed.setTimestamp();

        // Edit an existing embed message instead of posting a new one.
        if (editId) {
            const existing = await targetChannel.messages.fetch(editId).catch(() => null);
            if (!existing) {
                return message.reply({ embeds: [errorEmbed('Message Not Found', `No message with id \`${editId}\` in ${targetChannel}.`)] });
            }
            if (existing.author?.id !== message.client.user.id) {
                return message.reply({ embeds: [errorEmbed('Can\'t Edit', 'I can only edit embeds I posted myself.')] });
            }
            await existing.edit({ embeds: [embed] }).catch(() => {});
            await message.delete().catch(() => {});
            await logEmbedAction(message.client, message.author, targetChannel, 'edited', existing.url);
            const done = new EmbedBuilder().setColor(C.success).setTitle('`✅` Embed Updated')
                .setDescription(`Edited [message](${existing.url}) in ${targetChannel}.`).setFooter(FOOTER);
            return message.channel.send({ embeds: [done] })
                .then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
        }

        const sent = await targetChannel.send({ embeds: [embed] });
        await message.delete().catch(() => {});
        await logEmbedAction(message.client, message.author, targetChannel, 'posted', sent.url);
    };
}

module.exports = createEmbedHandler;
