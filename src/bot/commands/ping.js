// ═══════════════════════════════════════════════════════════════
//  UmbraX — .ping command
//  Report WebSocket + API latency and uptime.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { uptime } = require('../helpers');

/**
 * @param {{ client, startTime: number }} deps
 */
function createPingHandler(deps) {
    const { client, startTime } = deps;

    return async function handlePing(message) {
        const ws   = client.ws.ping;
        const t0   = Date.now();
        const sent = await message.reply({
            embeds: [new EmbedBuilder().setColor(C.main).setDescription('🏓 Pinging...')],
        });
        const api = Date.now() - t0;

        const wsColor  = ws  < 100 ? '🟢' : ws  < 200 ? '🟡' : '🔴';
        const apiColor = api < 200 ? '🟢' : api < 500 ? '🟡' : '🔴';

        const embed = new EmbedBuilder()
            .setColor(C.success)
            .setAuthor({ name: BRAND })
            .setTitle('`🏓` Pong!')
            .addFields(
                { name: `${wsColor} WebSocket`,    value: `\`${ws}ms\``,             inline: true },
                { name: `${apiColor} API Latency`, value: `\`${api}ms\``,            inline: true },
                { name: '⏱️ Uptime',               value: `\`${uptime(Date.now() - startTime)}\``, inline: true },
            )
            .setFooter(FOOTER)
            .setTimestamp();

        await sent.edit({ embeds: [embed] });
    };
}

module.exports = createPingHandler;
