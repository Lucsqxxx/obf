// ═══════════════════════════════════════════════════════════════
//  UmbraX — .stats command
//  Surface the lifetime usage counters the store already persists:
//  total obfuscations, bytes processed, unique users, encrypts,
//  uploads, error count, and how long tracking has been running.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { formatBytes, uptime } = require('../helpers');

/**
 * @param {{ usageStats: object, store: { firstSeen: number }, startTime: number }} deps
 */
function createStatsHandler(deps) {
    const { usageStats, store, startTime } = deps;

    return async function handleStats(message) {
        const s = usageStats;
        const uniqueUsers = s.users ? s.users.size : 0;
        // Total handled = obfuscate/secure runs + encrypts + uploads.
        const totalOps = (s.total || 0) + (s.encrypts || 0) + (s.uploads || 0);
        const attempts = totalOps + (s.errors || 0);
        const successRate = attempts > 0 ? Math.round((totalOps / attempts) * 100) : 100;
        const avgBytes = s.total > 0 ? Math.round(s.totalBytes / s.total) : 0;

        const trackingSince = store && store.firstSeen ? store.firstSeen : startTime;

        const embed = new EmbedBuilder()
            .setColor(C.info)
            .setAuthor({ name: BRAND })
            .setTitle('`📊` Lifetime Statistics')
            .setDescription('Aggregate usage across all servers, persisted across restarts.')
            .addFields(
                { name: '🛡️ Obfuscations', value: `\`${(s.total || 0).toLocaleString()}\``,    inline: true },
                { name: '🔐 Encrypts',     value: `\`${(s.encrypts || 0).toLocaleString()}\``, inline: true },
                { name: '📤 Uploads',      value: `\`${(s.uploads || 0).toLocaleString()}\``,  inline: true },
                { name: '👥 Unique Users', value: `\`${uniqueUsers.toLocaleString()}\``,       inline: true },
                { name: '📦 Bytes Handled', value: `\`${formatBytes(s.totalBytes || 0)}\``,    inline: true },
                { name: '📐 Avg Output',   value: `\`${formatBytes(avgBytes)}\``,              inline: true },
                { name: '✅ Success Rate', value: `\`${successRate}%\``,                       inline: true },
                { name: '⚠️ Errors',       value: `\`${(s.errors || 0).toLocaleString()}\``,   inline: true },
                { name: '🪤 Guards Deployed', value: `\`${(s.guardsDeployed || 0).toLocaleString()}\``, inline: true },
                { name: '⏱️ Session Up',   value: `\`${uptime(Date.now() - startTime)}\``,     inline: true },
            )
            .setFooter({ text: `${FOOTER.text} • tracking since` })
            .setTimestamp(new Date(trackingSince));

        // Community section — computed live from the store for this guild. Only
        // shown in a server (the counters are per-guild) and when the store
        // exposes the helpers, so a partial store never throws here.
        const guildId = message.guild?.id;
        if (guildId && store && typeof store.countWarnings === 'function') {
            const ticketsOpened = store.ticketCounters?.get?.(guildId) ?? 0;
            const activeGiveaways = typeof store.listGiveaways === 'function'
                ? store.listGiveaways().filter(g => g.guildId === guildId && !g.ended).length
                : 0;
            const positions = typeof store.listPositions === 'function'
                ? store.listPositions(guildId).length
                : 0;
            const totalWarnings = store.countWarnings(guildId);
            embed.addFields({
                name: '```🏠 This Server```',
                value: [
                    `🎫 Tickets opened: \`${ticketsOpened.toLocaleString()}\``,
                    `🎉 Active giveaways: \`${activeGiveaways.toLocaleString()}\``,
                    `📋 Application positions: \`${positions.toLocaleString()}\``,
                    `⚠️ Warnings recorded: \`${totalWarnings.toLocaleString()}\``,
                ].join('\n'),
                inline: false,
            });
        }

        await message.reply({ embeds: [embed] });
    };
}

module.exports = createStatsHandler;
