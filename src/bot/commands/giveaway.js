// ═══════════════════════════════════════════════════════════════
//  UmbraX — Giveaway system (staff only)
//
//  Button-entry giveaways that survive restarts. State lives in the
//  persistent store (data/state.json) keyed by the giveaway message id,
//  so the end-timer is rehydrated on boot and entrants are never lost.
//
//    .giveaway                                      — open the embed builder
//    .giveaway start <duration> <winners> <prize>   — begin a giveaway
//    .giveaway end   <messageId|latest>             — end it now & draw
//    .giveaway reroll <messageId|latest>            — pick new winner(s)
//    .giveaway list                                 — active giveaways
//
//  duration: 30s / 10m / 2h / 1d  •  winners: an integer (defaults to 1)
//  Example: `.giveaway start 1h 2 Nitro Classic`
//
//  Bare `.giveaway` opens the live-preview start builder: prize/duration/winners
//  plus the card's presentation (description, button label, color, image,
//  thumbnail, requirement note) and an optional @everyone ping. The chosen
//  presentation is stored on the record as `style`, so entry-count refreshes and
//  the ended state re-render with the same look.
//
//  Members enter by clicking the 🎉 button. Timers are scheduled with
//  setTimeout while running and re-armed from the stored `endsAt` on
//  boot (past-due giveaways are drawn immediately).
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { parseDuration, parseColor, isHttpUrl } = require('../helpers');

const ID_ENTER = 'umbrax_giveaway_enter';

// setTimeout uses a signed 32-bit ms delay (~24.8 days). Longer giveaways are
// re-armed in chunks so the timer never overflows to "fire immediately".
const MAX_TIMEOUT = 2_147_483_647;

function createGiveawayHandlers({ C, BRAND, FOOTER, store, client, config, hasStaffAccess, errorEmbed, staffAccessDeniedEmbed, builder }) {
    // messageId -> active setTimeout handle, so we can cancel on end/reroll.
    const timers = new Map();

    const err = (title, desc) => errorEmbed(title, desc);
    const ok = (title, desc, color = C.success) =>
        new EmbedBuilder().setColor(color).setAuthor({ name: BRAND }).setTitle(title).setDescription(desc).setFooter(FOOTER).setTimestamp();

    // ── .giveaway <sub> ──────────────────────────────────────────
    async function giveaway(message, args) {
        if (!message.guild) return message.reply({ embeds: [err('Guild Only', 'Giveaways can only be run in a server.')] });
        if (!hasStaffAccess(message, config.managerRoleId)) {
            return message.reply({ embeds: [staffAccessDeniedEmbed(config.managerRoleId)] });
        }

        const sub = (args[0] || '').toLowerCase();
        switch (sub) {
            case 'start':  return startGiveaway(message, args.slice(1));
            case 'end':    return endCommand(message, args.slice(1));
            case 'reroll': return rerollCommand(message, args.slice(1));
            case 'list':   return listGiveaways(message);
            case '':
                // Bare `.giveaway` → open the interactive live-preview builder
                // when available, otherwise fall through to the usage help.
                if (builder) return builder.start(message, giveawayBuilderSpec());
                // falls through
            default:
                return message.reply({ embeds: [err(
                    'Giveaway',
                    [
                        '`.giveaway start <duration> <winners> <prize>` — start one',
                        '`.giveaway end <messageId|latest>` — end & draw now',
                        '`.giveaway reroll <messageId|latest>` — draw again',
                        '`.giveaway list` — active giveaways',
                        '',
                        'Example: `.giveaway start 1h 2 Nitro Classic`',
                        'Tip: run `.giveaway` with no arguments for a guided builder.',
                    ].join('\n'),
                )] });
        }
    }

    // ── Interactive builder spec ─────────────────────────────────
    // Lets staff compose a giveaway with a live preview (bare `.giveaway`).
    // Mirrors the text path — the same `beginGiveaway` core actually starts it.
    //
    // The "Appearance" group only feeds the card's presentation (`style`), which
    // is persisted on the record so entry-count refreshes and the ended state
    // re-render with the same look instead of snapping back to the default.
    function giveawayBuilderSpec() {
        return {
            kind: 'giveaway',
            title: 'Giveaway Builder',
            accent: C.pink,
            channelTarget: true,
            fields: [
                { key: 'prize',       label: 'Prize',              kind: 'short',     max: 256,  placeholder: 'Nitro Classic', required: true },
                { key: 'duration',    label: 'Duration',           kind: 'short',     max: 16,   placeholder: '1h  •  30m  •  2d', required: true },
                { key: 'winners',     label: 'Winners (1-20)',     kind: 'short',     max: 3,    placeholder: '1', initial: '1' },
                { key: 'description', label: 'Description',        kind: 'paragraph', max: 2000, placeholder: 'Leave blank for the default "Click Enter to join."' },
                { key: 'button',      label: 'Button Label',       kind: 'short',     max: 80,   placeholder: 'Enter' },
                { key: 'color',       label: 'Color (name or #hex)', kind: 'short',   max: 32,   placeholder: 'pink  or  #EC4899' },
                { key: 'image',       label: 'Image URL',          kind: 'short',     max: 512,  placeholder: 'https://…' },
                { key: 'thumbnail',   label: 'Thumbnail URL',      kind: 'short',     max: 512,  placeholder: 'https://…' },
                { key: 'requirement', label: 'Requirement note',   kind: 'short',     max: 256,  placeholder: 'Must be in the server for 7 days' },
            ],
            groups: [
                { label: 'Giveaway',   keys: ['prize', 'duration', 'winners', 'requirement'] },
                { label: 'Appearance', keys: ['description', 'button', 'color', 'image', 'thumbnail'] },
            ],
            toggles: [
                { key: 'ping', label: 'Ping', onText: '🔔 Ping @everyone: On', offText: '🔔 Ping @everyone: Off' },
            ],
            buildPreview(v) {
                const durMs = parseDuration((v.duration || '').trim());
                return giveawayEmbed({
                    prize:    (v.prize || '').trim() || '(prize not set yet)',
                    winners:  clampWinners(v.winners),
                    endsAt:   nowMs() + (durMs || 0),
                    host:     '0',
                    entrants: 0,
                    ended:    false,
                    style:    styleFromValues(v),
                    previewHost: true,
                });
            },
            previewContent(v, t) { return t.ping ? '@everyone' : undefined; },
            validate(v) {
                if (!(v.prize || '').trim()) return 'Tell me what the prize is.';
                if (!parseDuration((v.duration || '').trim())) return 'Set a valid duration like `30s`, `10m`, `2h`, or `1d`.';
                if (v.winners && !/^\d+$/.test(v.winners.trim())) return 'Winners must be a whole number.';
                if (v.color && parseColor(v.color) === null) return 'Color must be a name (`pink`, `purple`, …) or a hex like `#EC4899`.';
                if (v.image && !isHttpUrl(v.image)) return 'The image must be an `https://` URL.';
                if (v.thumbnail && !isHttpUrl(v.thumbnail)) return 'The thumbnail must be an `https://` URL.';
                return null;
            },
            async submit({ values, toggles, targetChannel, interaction }) {
                const durMs   = parseDuration((values.duration || '').trim());
                const winners = clampWinners(values.winners);
                const prize   = (values.prize || '').trim();
                await beginGiveaway({
                    channel:  targetChannel,
                    guildId:  targetChannel.guild?.id || interaction.guild?.id,
                    prize, winners, durMs,
                    host:     interaction.user.id,
                    style:    styleFromValues(values),
                    ping:     !!toggles.ping,
                });
                return `Giveaway for **${prize}** started in ${targetChannel} — ${winners} winner${winners === 1 ? '' : 's'}, ends <t:${Math.floor((nowMs() + durMs) / 1000)}:R>.`;
            },
        };
    }

    // Distil the builder's presentation fields into the compact `style` object
    // stored on the record. Only validated values survive, so a bad URL left in
    // the modal can never reach `EmbedBuilder` and throw at render time.
    function styleFromValues(v) {
        const style = {};
        const desc = (v.description || '').trim();
        const req  = (v.requirement || '').trim();
        const btn  = (v.button || '').trim();
        if (desc) style.description = desc.slice(0, 2000);
        if (req)  style.requirement = req.slice(0, 256);
        if (btn)  style.button = btn.slice(0, 80);
        const color = parseColor(v.color);
        if (color !== null) style.color = color;
        if (v.image && isHttpUrl(v.image)) style.image = v.image.trim();
        if (v.thumbnail && isHttpUrl(v.thumbnail)) style.thumbnail = v.thumbnail.trim();
        return style;
    }

    // ── start ────────────────────────────────────────────────────
    async function startGiveaway(message, args) {
        const durMs = parseDuration(args[0]);
        if (!durMs) return message.reply({ embeds: [err('Invalid Duration', 'Use `30s`, `10m`, `2h`, or `1d`. Usage: `.giveaway start <duration> <winners> <prize>`')] });

        // winners is optional (defaults to 1); if omitted, arg[1] is part of prize.
        let winners = 1;
        let prizeArgs = args.slice(1);
        if (/^\d+$/.test(args[1] || '')) {
            winners = clampWinners(args[1]);
            prizeArgs = args.slice(2);
        }
        const prize = prizeArgs.join(' ').trim();
        if (!prize) return message.reply({ embeds: [err('No Prize', 'Tell me what the prize is. Usage: `.giveaway start <duration> <winners> <prize>`')] });

        await beginGiveaway({
            channel:  message.channel,
            guildId:  message.guild.id,
            prize, winners, durMs,
            host:     message.author.id,
        });
        await message.delete().catch(() => {});
    }

    // Shared core: post the giveaway message, persist it, and arm its timer.
    // Used by both the text `start` path and the interactive builder's submit.
    async function beginGiveaway({ channel, guildId, prize, winners, durMs, host, style, ping }) {
        const endsAt = nowMs() + durMs;

        const embed = giveawayEmbed({ prize, winners, endsAt, host, entrants: 0, ended: false, style });
        const row = entryRow(false, style);

        // The host (<@id>) is named on the card but must never be pinged just for
        // starting a giveaway, so only @everyone is ever allowed through — and
        // only when staff explicitly toggled it on in the builder.
        const sent = await channel.send({
            content: ping ? '@everyone' : undefined,
            embeds: [embed],
            components: [row],
            allowedMentions: ping ? { parse: ['everyone'] } : { parse: [] },
        });

        const record = {
            messageId: sent.id,
            channelId: sent.channel.id,
            guildId,
            prize, winners,
            host,
            endsAt,
            entrants:  [],           // user ids
            ended:     false,
            winnerIds: [],
            // Presentation chosen in the builder; absent for text-path giveaways,
            // which render with the defaults.
            style: (style && Object.keys(style).length) ? style : undefined,
        };
        store.saveGiveaway(record);
        arm(record);
        return record;
    }

    // Coerce a winners token to an integer in [1, 20]; defaults to 1.
    function clampWinners(tok) {
        const n = parseInt(tok, 10);
        if (!Number.isFinite(n)) return 1;
        return Math.max(1, Math.min(20, n));
    }

    // ── entry button ─────────────────────────────────────────────
    async function handleInteraction(interaction) {
        if (!interaction.isButton?.() || interaction.customId !== ID_ENTER) return false;

        const g = store.getGiveaway(interaction.message.id);
        if (!g || g.ended) {
            await interaction.reply({ content: 'This giveaway has ended.', ephemeral: true }).catch(() => {});
            return true;
        }

        const uid = interaction.user.id;
        const idx = g.entrants.indexOf(uid);
        let note;
        if (idx === -1) { g.entrants.push(uid); note = '🎉 You\'re entered! Click again to leave.'; }
        else            { g.entrants.splice(idx, 1); note = 'You\'ve left the giveaway.'; }
        store.saveGiveaway(g);

        // Refresh the entrant count on the message (best-effort).
        await updateMessage(g).catch(() => {});
        await interaction.reply({ content: note, ephemeral: true }).catch(() => {});
        return true;
    }

    // ── end / reroll / list ──────────────────────────────────────
    async function endCommand(message, args) {
        const g = resolveTarget(message, args[0]);
        if (!g) return message.reply({ embeds: [err('Not Found', 'No matching giveaway. Pass a message id or `latest`.')] });
        if (g.ended) return message.reply({ embeds: [err('Already Ended', 'That giveaway has already ended. Use `.giveaway reroll` to draw again.')] });
        await endGiveaway(g.messageId, message.author.id);
        return message.reply({ embeds: [ok('`🎉` Giveaway Ended', `Drew winners for **${g.prize}**.`, C.success)] });
    }

    async function rerollCommand(message, args) {
        const g = resolveTarget(message, args[0]);
        if (!g) return message.reply({ embeds: [err('Not Found', 'No matching giveaway. Pass a message id or `latest`.')] });
        if (!g.ended) return message.reply({ embeds: [err('Still Running', 'That giveaway hasn\'t ended yet. Use `.giveaway end` first.')] });

        const winners = drawWinners(g.entrants, g.winners);
        if (!winners.length) return message.reply({ embeds: [err('No Entrants', 'Nobody entered, so there\'s no one to reroll.')] });
        g.winnerIds = winners;
        store.saveGiveaway(g);

        const channel = await fetchChannel(g);
        if (channel) {
            await channel.send({
                content: `🎉 **Reroll!** New winner${winners.length > 1 ? 's' : ''} for **${g.prize}**: ${winners.map(w => `<@${w}>`).join(', ')}`,
                allowedMentions: { users: winners },
            }).catch(() => {});
        }
        return message.reply({ embeds: [ok('`🔁` Rerolled', `New winner${winners.length > 1 ? 's' : ''}: ${winners.map(w => `<@${w}>`).join(', ')}`, C.info)] });
    }

    async function listGiveaways(message) {
        const active = store.listGiveaways().filter(g => g.guildId === message.guild.id && !g.ended);
        if (!active.length) return message.reply({ embeds: [ok('`🎉` Giveaways', 'No active giveaways right now.', C.info)] });
        const lines = active.map(g => `• **${g.prize}** — ${g.entrants.length} entrant${g.entrants.length === 1 ? '' : 's'} • ends <t:${Math.floor(g.endsAt / 1000)}:R> • \`${g.messageId}\``);
        return message.reply({ embeds: [ok('`🎉` Active Giveaways', lines.join('\n'), C.info)] });
    }

    // Resolve `latest` or a message id to a stored giveaway in this guild.
    function resolveTarget(message, token) {
        const all = store.listGiveaways().filter(g => g.guildId === message.guild.id);
        if (!token || token.toLowerCase() === 'latest') {
            if (!all.length) return null;
            return all.sort((a, b) => b.endsAt - a.endsAt)[0];
        }
        return all.find(g => g.messageId === token) || null;
    }

    // ── Ending + drawing ─────────────────────────────────────────
    async function endGiveaway(messageId, endedBy = null) {
        const g = store.getGiveaway(messageId);
        if (!g || g.ended) return;

        clearTimer(messageId);
        g.ended = true;
        g.winnerIds = drawWinners(g.entrants, g.winners);
        if (endedBy) g.endedBy = endedBy;
        store.saveGiveaway(g);

        const channel = await fetchChannel(g);
        if (!channel) return;

        // Update the giveaway embed to the ended state + disable the button.
        await updateMessage(g, true).catch(() => {});

        if (g.winnerIds.length) {
            await channel.send({
                content: `🎉 Congratulations ${g.winnerIds.map(w => `<@${w}>`).join(', ')}! You won **${g.prize}**!`,
                allowedMentions: { users: g.winnerIds },
            }).catch(() => {});
        } else {
            await channel.send({ content: `🎉 The giveaway for **${g.prize}** ended, but nobody entered.` }).catch(() => {});
        }
    }

    // Fisher–Yates pick of up to `count` distinct entrants. Uses store save time
    // as a seed source is unnecessary — Math.random is fine for a fun draw, but
    // it's unavailable in some sandboxes; fall back to a rotating index if so.
    function drawWinners(entrants, count) {
        const pool = [...new Set(entrants)];
        const n = Math.min(count, pool.length);
        for (let i = pool.length - 1; i > 0; i--) {
            const j = randInt(i + 1);
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return pool.slice(0, n);
    }

    // ── Message rendering ────────────────────────────────────────
    function giveawayEmbed({ prize, winners, endsAt, host, entrants, ended, winnerIds, style = {}, previewHost }) {
        // In the builder preview the host id isn't meaningful yet, so show a
        // neutral label instead of a `<@0>` mention.
        const hostValue = previewHost ? 'you' : `<@${host}>`;
        const when = Math.floor(endsAt / 1000);
        const label = style.button || 'Enter';

        // A custom color applies while running; the ended card always turns amber
        // so a finished giveaway stays visually distinct from a live one.
        const embed = new EmbedBuilder()
            .setColor(ended ? C.warn : (style.color ?? C.pink))
            .setTitle(`🎉  ${prize}`)
            .setFooter({ text: `${ended ? 'Ended' : 'Ends'} • ${FOOTER.text}` })
            .setTimestamp(new Date(endsAt));

        if (style.thumbnail) embed.setThumbnail(style.thumbnail);

        if (ended) {
            embed.setDescription(
                winnerIds && winnerIds.length
                    ? `**Winner${winnerIds.length > 1 ? 's' : ''}:** ${winnerIds.map(w => `<@${w}>`).join(', ')}`
                    : '*No valid entrants.*',
            ).addFields({ name: 'Host', value: hostValue, inline: true });
        } else {
            embed.setDescription(style.description || `Click **🎉 ${label}** below to join.`)
                .addFields(
                    { name: 'Winners', value: `\`${winners}\``, inline: true },
                    { name: 'Entries', value: `\`${entrants}\``, inline: true },
                    { name: 'Host',    value: hostValue,        inline: true },
                    { name: 'Ends',    value: `<t:${when}:R>`,   inline: false },
                );
            if (style.requirement) embed.addFields({ name: 'Requirement', value: style.requirement, inline: false });
            // The banner is only meaningful on the live card — the ended state is
            // a short winners announcement.
            if (style.image) embed.setImage(style.image);
        }
        return embed;
    }

    // The entry button, in its live or ended form. Shared by the initial post and
    // every re-render so the custom label survives entry-count refreshes.
    function entryRow(ended, style = {}) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(ID_ENTER)
                .setLabel(ended ? 'Ended' : (style.button || 'Enter'))
                .setEmoji('🎉')
                .setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Success)
                .setDisabled(ended),
        );
    }

    // Re-render the giveaway message from its stored record.
    async function updateMessage(g, ended = g.ended) {
        const channel = await fetchChannel(g);
        if (!channel) return;
        const msg = await channel.messages.fetch(g.messageId).catch(() => null);
        if (!msg) return;

        const embed = giveawayEmbed({
            prize: g.prize, winners: g.winners, endsAt: g.endsAt, host: g.host,
            entrants: g.entrants.length, ended, winnerIds: g.winnerIds, style: g.style,
        });
        // Preserve the original `content` (an @everyone ping, if staff enabled
        // one) — an edit that omits it would strip the ping line off the card.
        await msg.edit({ embeds: [embed], components: [entryRow(ended, g.style)] }).catch(() => {});
    }

    async function fetchChannel(g) {
        return client.channels.fetch(g.channelId).catch(() => null);
    }

    // ── Timers ───────────────────────────────────────────────────
    // Arm (or re-arm) the end-timer for a giveaway. Chunks delays beyond the
    // 32-bit setTimeout ceiling; fires immediately if already past due.
    function arm(g) {
        clearTimer(g.messageId);
        const delay = g.endsAt - nowMs();
        if (delay <= 0) { endGiveaway(g.messageId); return; }
        const chunk = Math.min(delay, MAX_TIMEOUT);
        const t = setTimeout(() => {
            if (chunk < delay) arm(store.getGiveaway(g.messageId) || g);   // more to wait
            else endGiveaway(g.messageId);
        }, chunk);
        if (t.unref) t.unref();
        timers.set(g.messageId, t);
    }

    function clearTimer(messageId) {
        const t = timers.get(messageId);
        if (t) { clearTimeout(t); timers.delete(messageId); }
    }

    // Called once on client ready: re-arm every unfinished giveaway and prune
    // finished ones older than a day so state.json doesn't grow unbounded.
    function rehydrate() {
        const DAY = 86_400_000;
        for (const g of store.listGiveaways()) {
            if (g.ended) {
                if (nowMs() - g.endsAt > DAY) store.deleteGiveaway(g.messageId);
                continue;
            }
            arm(g);
        }
    }

    return { giveaway, handleInteraction, rehydrate };
}

// ── time helpers (Date.now is fine in the live bot) ──────────────
function nowMs() { return Date.now(); }
function randInt(n) { return Math.floor(Math.random() * n); }

module.exports = createGiveawayHandlers;
// Re-exported for callers/tests that historically imported it from here; the
// canonical implementation now lives in helpers.js (shared with moderation).
module.exports.parseDuration = parseDuration;
