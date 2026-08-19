// ═══════════════════════════════════════════════════════════════
//  UmbraX — .say command (staff only)
//  Post plain text as the bot, then delete the invoking message. Useful
//  for quick announcements that don't need the full .embed builder.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { errorEmbed } = require('../helpers');

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

        await message.channel.send({ content: text, allowedMentions: { parse: [] } });
        await message.delete().catch(() => {});
    };
}

module.exports = createSayHandler;
