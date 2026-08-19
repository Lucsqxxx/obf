// ═══════════════════════════════════════════════════════════════
//  UmbraX — Community moderation commands
//
//  Staff tools for the community server: .clear/.purge, .kick, .ban,
//  .timeout/.mute, .warn, .warnings, .unwarn. Each command is gated by
//  the invoker's Discord permissions (not the obfuscator role) and
//  re-checks the bot's own permissions + role hierarchy before acting,
//  so a missing permission produces a clean message instead of an
//  unhandled reject. Targets are DM'd the action + reason (best-effort).
//
//  Warnings are PERSISTED in the store (data/state.json), keyed by
//  guild+user, so they survive restarts. Reaching a threshold
//  auto-escalates to a timeout (see WARN_ESCALATION).
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { parseDuration, humanizeDuration } = require('../helpers');

const P = PermissionsBitField.Flags;

// Discord caps timeouts at 28 days.
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

// Auto-escalation: when a user's total warning count reaches a threshold, apply
// the paired timeout automatically. Checked high-to-low so the harshest
// matching rule wins. Tune freely — the entries just map count → timeout ms.
const WARN_ESCALATION = [
    { at: 5, ms: 24 * 60 * 60 * 1000 },   // 5 warns → 1 day
    { at: 3, ms: 60 * 60 * 1000 },        // 3 warns → 1 hour
];

function createModerationHandlers({ C, BRAND, FOOTER, store }) {
    // ── Local embed helpers ──────────────────────────────────────
    const err = (title, desc) =>
        new EmbedBuilder().setColor(C.error).setTitle(`\`❌\` ${title}`).setDescription(desc).setFooter(FOOTER).setTimestamp();

    const ok = (title, desc, color = C.success) =>
        new EmbedBuilder().setColor(color).setAuthor({ name: BRAND }).setTitle(title).setDescription(desc).setFooter(FOOTER).setTimestamp();

    // DM a member about a moderation action taken against them. Best-effort:
    // many users have DMs closed, so failures are swallowed. `fields` is an
    // optional array of extra { name, value } lines (e.g. duration).
    async function notifyTarget(target, guildName, action, reason, color, fields = []) {
        const dm = new EmbedBuilder()
            .setColor(color)
            .setAuthor({ name: BRAND })
            .setTitle(`You were ${action}`)
            .setDescription(`This happened in **${guildName}**.`)
            .addFields({ name: 'Reason', value: reason || 'No reason provided', inline: false }, ...fields)
            .setFooter(FOOTER)
            .setTimestamp();
        await target.send({ embeds: [dm] }).catch(() => {});
    }

    // Guard shared by every command: must be in a guild, invoker must hold
    // `perm`, and the bot must hold `perm` too. Returns an error embed to send,
    // or null when all checks pass.
    function precheck(message, perm, permLabel) {
        if (!message.guild) return err('Guild Only', 'This command can only be used in a server.');
        if (!message.member?.permissions?.has(perm)) {
            return err('Missing Permission', `You need the **${permLabel}** permission to use this.`);
        }
        if (!message.guild.members.me?.permissions?.has(perm)) {
            return err('I Can\'t Do That', `I\'m missing the **${permLabel}** permission. Ask an admin to grant it to me.`);
        }
        return null;
    }

    // Can the actor (and the bot) act on `target`? Blocks moderating staff above
    // you, the server owner, and yourself. Returns an error embed or null.
    function canActOn(message, target, verb) {
        if (target.id === message.author.id) return err('Nope', `You can\'t ${verb} yourself.`);
        if (target.id === message.guild.ownerId) return err('Nope', `You can\'t ${verb} the server owner.`);
        if (target.id === message.client.user.id) return err('Nope', `I can\'t ${verb} myself.`);
        const me = message.guild.members.me;
        if (target.roles.highest.position >= message.member.roles.highest.position && message.author.id !== message.guild.ownerId) {
            return err('Role Hierarchy', `You can\'t ${verb} someone with an equal or higher role than you.`);
        }
        if (me && target.roles.highest.position >= me.roles.highest.position) {
            return err('Role Hierarchy', `My role is not high enough to ${verb} that member. Move my role up.`);
        }
        return null;
    }

    // Resolve the first mentioned member, or an ID as the first arg. Returns the
    // GuildMember or null (caller reports "not found").
    async function resolveTarget(message, args) {
        const mentioned = message.mentions?.members?.first?.();
        if (mentioned) return mentioned;
        const id = (args[0] || '').replace(/[<@!>]/g, '');
        if (/^\d{16,20}$/.test(id)) {
            return message.guild.members.fetch(id).catch(() => null);
        }
        return null;
    }

    // ── .clear / .purge <count> [@user] ──────────────────────────
    async function clear(message, args) {
        const bad = precheck(message, P.ManageMessages, 'Manage Messages');
        if (bad) return message.reply({ embeds: [bad] });

        const count = parseInt(args[0], 10);
        if (!Number.isInteger(count) || count < 1 || count > 100) {
            return message.reply({ embeds: [err('Invalid Amount', 'Provide a number between **1** and **100**. Usage: `.clear <1-100> [@user]`')] });
        }

        // Optional user filter: `.clear 50 @user` only deletes that member's
        // recent messages (fetched, then filtered, within the 14-day window).
        const filterMember = message.mentions?.members?.first?.();

        let removed = 0;
        if (filterMember) {
            const fetched = await message.channel.messages.fetch({ limit: 100 }).catch(() => null);
            if (!fetched) return message.channel.send({ embeds: [err('Clear Failed', 'Could not read channel history.')] });
            const mine = [...fetched.values()].filter(m => m.author.id === filterMember.id).slice(0, count);
            const deleted = await message.channel.bulkDelete(mine, true).catch(() => null);
            removed = deleted ? deleted.size : 0;
            await message.delete().catch(() => {});
        } else {
            // Delete `count` messages PLUS the command message itself, but never
            // ask Discord for more than 100 in one bulkDelete (its hard cap — a
            // request of 101 throws, which is why `.clear 100` silently failed).
            // bulkDelete also skips messages older than 14 days (a Discord limit),
            // so we surface the real error instead of a blanket guess.
            const want = Math.min(count + 1, 100);
            let deleted;
            try {
                deleted = await message.channel.bulkDelete(want, true);
            } catch (e) {
                return message.channel.send({ embeds: [err('Clear Failed', `Couldn't delete messages: ${e.message}`)] });
            }
            removed = Math.max(0, deleted.size - 1);
            if (removed === 0) {
                return message.channel.send({ embeds: [err('Nothing Cleared', 'No deletable messages found — they may be older than **14 days** (Discord won\'t bulk-delete those).')] });
            }
        }

        const who = filterMember ? ` from **${filterMember.user.tag}**` : '';
        const note = await message.channel.send({
            embeds: [ok('`🧹` Messages Cleared', `Deleted **${removed}** message${removed === 1 ? '' : 's'}${who}.`, C.cyan)],
        });
        // Auto-remove the confirmation after a few seconds to keep the channel tidy.
        setTimeout(() => note.delete().catch(() => {}), 4000);
    }

    // ── .kick <@user|id> [reason] ────────────────────────────────
    async function kick(message, args) {
        const bad = precheck(message, P.KickMembers, 'Kick Members');
        if (bad) return message.reply({ embeds: [bad] });

        const target = await resolveTarget(message, args);
        if (!target) return message.reply({ embeds: [err('Not Found', 'Mention a member or provide their ID. Usage: `.kick @user [reason]`')] });

        const block = canActOn(message, target, 'kick');
        if (block) return message.reply({ embeds: [block] });
        if (!target.kickable) return message.reply({ embeds: [err('Can\'t Kick', 'I\'m unable to kick that member.')] });

        const reason = args.slice(1).join(' ') || 'No reason provided';
        // DM before the kick — afterwards we may no longer share a server.
        await notifyTarget(target, message.guild.name, 'kicked', reason, C.orange);
        const done = await target.kick(`${message.author.tag}: ${reason}`).then(() => true).catch(() => false);
        if (!done) return message.reply({ embeds: [err('Kick Failed', 'Something went wrong kicking that member.')] });
        return message.reply({ embeds: [ok('`👢` Member Kicked', `**${target.user.tag}** was kicked.\n> **Reason:** ${reason}`, C.orange)] });
    }

    // ── .ban <@user|id> [reason] ─────────────────────────────────
    async function ban(message, args) {
        const bad = precheck(message, P.BanMembers, 'Ban Members');
        if (bad) return message.reply({ embeds: [bad] });

        const target = await resolveTarget(message, args);
        if (!target) return message.reply({ embeds: [err('Not Found', 'Mention a member or provide their ID. Usage: `.ban @user [reason]`')] });

        const block = canActOn(message, target, 'ban');
        if (block) return message.reply({ embeds: [block] });
        if (!target.bannable) return message.reply({ embeds: [err('Can\'t Ban', 'I\'m unable to ban that member.')] });

        const reason = args.slice(1).join(' ') || 'No reason provided';
        await notifyTarget(target, message.guild.name, 'banned', reason, C.error);
        const done = await target.ban({ reason: `${message.author.tag}: ${reason}` }).then(() => true).catch(() => false);
        if (!done) return message.reply({ embeds: [err('Ban Failed', 'Something went wrong banning that member.')] });
        return message.reply({ embeds: [ok('`🔨` Member Banned', `**${target.user.tag}** was banned.\n> **Reason:** ${reason}`, C.error)] });
    }

    // ── .timeout / .mute <@user|id> <duration> [reason] ──────────
    async function timeout(message, args) {
        const bad = precheck(message, P.ModerateMembers, 'Timeout Members');
        if (bad) return message.reply({ embeds: [bad] });

        const target = await resolveTarget(message, args);
        if (!target) return message.reply({ embeds: [err('Not Found', 'Mention a member or provide their ID. Usage: `.timeout @user <10m|1h|1d> [reason]`')] });

        const block = canActOn(message, target, 'time out');
        if (block) return message.reply({ embeds: [block] });
        if (!target.moderatable) return message.reply({ embeds: [err('Can\'t Timeout', 'I\'m unable to time out that member.')] });

        const durMs = parseDuration(args[1]);
        if (!durMs) return message.reply({ embeds: [err('Invalid Duration', 'Use a duration like `10m`, `1h`, or `1d` (max 28d). Usage: `.timeout @user <duration> [reason]`')] });
        if (durMs > MAX_TIMEOUT_MS) return message.reply({ embeds: [err('Too Long', 'The maximum timeout is **28 days**.')] });

        const reason = args.slice(2).join(' ') || 'No reason provided';
        const human = humanizeDuration(durMs);
        const done = await target.timeout(durMs, `${message.author.tag}: ${reason}`).then(() => true).catch(() => false);
        if (!done) return message.reply({ embeds: [err('Timeout Failed', 'Something went wrong timing out that member.')] });
        await notifyTarget(target, message.guild.name, `timed out for ${human}`, reason, C.warn,
            [{ name: 'Duration', value: human, inline: true }]);
        return message.reply({ embeds: [ok('`🔇` Member Timed Out', `**${target.user.tag}** was timed out for **${human}**.\n> **Reason:** ${reason}`, C.warn)] });
    }

    // ── .warn <@user|id> [reason] ────────────────────────────────
    async function warn(message, args) {
        const bad = precheck(message, P.ModerateMembers, 'Timeout Members');
        if (bad) return message.reply({ embeds: [bad] });

        const target = await resolveTarget(message, args);
        if (!target) return message.reply({ embeds: [err('Not Found', 'Mention a member or provide their ID. Usage: `.warn @user [reason]`')] });

        const block = canActOn(message, target, 'warn');
        if (block) return message.reply({ embeds: [block] });

        const reason = args.slice(1).join(' ') || 'No reason provided';
        const count = store.addWarning(message.guild.id, target.id, {
            reason, by: message.author.id, at: Date.now(),
        });

        // Auto-escalate: apply the harshest matching timeout for this count.
        let escalation = null;
        const rule = WARN_ESCALATION.find(r => count === r.at);
        if (rule && target.moderatable && message.guild.members.me?.permissions?.has(P.ModerateMembers)) {
            const applied = await target.timeout(rule.ms, `Auto-escalation: reached ${count} warnings`).then(() => true).catch(() => false);
            if (applied) escalation = humanizeDuration(rule.ms);
        }

        await notifyTarget(target, message.guild.name, 'warned', reason, C.warn,
            [{ name: 'Total warnings', value: String(count), inline: true },
                ...(escalation ? [{ name: 'Auto-timeout', value: escalation, inline: true }] : [])]);

        const lines = [
            `**${target.user.tag}** was warned.`,
            `> **Reason:** ${reason}`,
            `> **Total warnings:** ${count}`,
        ];
        if (escalation) lines.push(`> **Auto-timeout:** ${escalation} (reached ${count} warnings)`);
        return message.reply({ embeds: [ok('`⚠️` Member Warned', lines.join('\n'), C.warn)] });
    }

    // ── .warnings <@user|id> ─────────────────────────────────────
    // List a member's stored warnings. Anyone with Moderate Members can view.
    async function warnings(message, args) {
        const bad = precheck(message, P.ModerateMembers, 'Timeout Members');
        if (bad) return message.reply({ embeds: [bad] });

        const target = await resolveTarget(message, args);
        if (!target) return message.reply({ embeds: [err('Not Found', 'Mention a member or provide their ID. Usage: `.warnings @user`')] });

        const list = store.getWarnings(message.guild.id, target.id);
        if (!list.length) return message.reply({ embeds: [ok('`📋` No Warnings', `**${target.user.tag}** has a clean record.`, C.success)] });

        // Show the most recent 10, numbered, with who issued them and when.
        const shown = list.slice(-10);
        const offset = list.length - shown.length;
        const body = shown.map((w, i) =>
            `\`${offset + i + 1}.\` ${w.reason} — by <@${w.by}> • <t:${Math.floor(w.at / 1000)}:R>`).join('\n');
        const more = list.length > shown.length ? `\n\n*…and ${list.length - shown.length} older.*` : '';
        return message.reply({
            embeds: [ok(`\`⚠️\` Warnings — ${target.user.tag}`, `**${list.length}** total.\n\n${body}${more}`, C.warn)],
        });
    }

    // ── .unwarn <@user|id> [index|all] ───────────────────────────
    // Remove one warning (by 1-based index) or clear all of a user's warnings.
    async function unwarn(message, args) {
        const bad = precheck(message, P.ModerateMembers, 'Timeout Members');
        if (bad) return message.reply({ embeds: [bad] });

        const target = await resolveTarget(message, args);
        if (!target) return message.reply({ embeds: [err('Not Found', 'Mention a member or provide their ID. Usage: `.unwarn @user [index|all]`')] });

        // Second arg after the target: an index or "all" (default clears all).
        const rest = args.filter(a => !a.includes(target.id) && a !== `<@${target.id}>` && a !== `<@!${target.id}>`);
        const token = (rest[0] || 'all').toLowerCase();

        if (token === 'all') {
            const n = store.clearWarnings(message.guild.id, target.id);
            if (!n) return message.reply({ embeds: [err('No Warnings', `**${target.user.tag}** had no warnings to clear.`)] });
            return message.reply({ embeds: [ok('`🧽` Warnings Cleared', `Removed all **${n}** warning${n === 1 ? '' : 's'} from **${target.user.tag}**.`, C.success)] });
        }

        const idx = parseInt(token, 10);
        if (!Number.isInteger(idx) || idx < 1) {
            return message.reply({ embeds: [err('Invalid Index', 'Pass a warning number (see `.warnings @user`) or `all`. Usage: `.unwarn @user [index|all]`')] });
        }
        const removed = store.removeWarning(message.guild.id, target.id, idx);
        if (!removed) return message.reply({ embeds: [err('Not Found', `There's no warning \`#${idx}\` for **${target.user.tag}**. See \`.warnings @user\`.`)] });
        const left = store.getWarnings(message.guild.id, target.id).length;
        return message.reply({ embeds: [ok('`🧽` Warning Removed', `Removed warning \`#${idx}\` from **${target.user.tag}**.\n> **Remaining:** ${left}`, C.success)] });
    }

    return { clear, kick, ban, timeout, warn, warnings, unwarn };
}

module.exports = createModerationHandlers;
