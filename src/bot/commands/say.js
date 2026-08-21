// ═══════════════════════════════════════════════════════════════
//  UmbraX — .say command (staff only)
//  Post plain text as the bot, then delete the invoking message. Useful
//  for quick announcements that don't need the full .embed builder.
//  Mirrored to config.modLogChannelId (if set) as an audit trail — the
//  in-channel copy alone doesn't record WHO posted it.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { errorEmbed, sendModLog } = require('../helpers');
const config = require('../config');

function createSayHandler() {
    return async function handleSay(message, args) {
        const text = args.join(' ').trim();
        if (!text) {
            return message.reply({
                embeds: [errorEmbed('Nothing to Say', 'Provide text after the command. Usage: `.say <message>`')],
            });
        }
        if (text.length > 2000) {
            return message.reply({ embeds: [errorEmbed('Too Long', 'Discord messages are capped at **2000** characters.')] });
        }

        const sent = await message.channel.send({ content: text, allowedMentions: { parse: [] } });
        await message.delete().catch(() => {});

        const log = new EmbedBuilder()
            .setColor(C.info)
            .setAuthor({ name: BRAND })
            .setTitle('`💬` .say Used')
            .setDescription([
                `> **By:** ${message.author} (\`${message.author.id}\`)`,
                `> **In:** ${message.channel} • [jump](${sent.url})`,
                '',
                text.length > 500 ? text.slice(0, 500) + '…' : text,
            ].join('\n'))
            .setFooter(FOOTER)
            .setTimestamp();
        await sendModLog(message.client, config, log);
    };
}

module.exports = createSayHandler;
