// ═══════════════════════════════════════════════════════════════
//  UmbraX — .serverinfo command
//  At-a-glance info about the current server.
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { errorEmbed } = require('../helpers');

function createServerInfoHandler() {
    return async function handleServerInfo(message) {
        const guild = message.guild;
        if (!guild) return message.reply({ embeds: [errorEmbed('Guild Only', 'This command only works in a server.')] });

        const owner = await guild.fetchOwner().catch(() => null);
        const textChannels = guild.channels.cache.filter(c => c.isTextBased?.() && !c.isVoiceBased?.()).size;
        const voiceChannels = guild.channels.cache.filter(c => c.isVoiceBased?.()).size;

        const embed = new EmbedBuilder()
            .setColor(C.main)
            .setAuthor({ name: BRAND })
            .setTitle(`\`🏠\` ${guild.name}`)
            .setThumbnail(guild.iconURL({ size: 256 }) || null)
            .addFields(
                { name: 'Owner',       value: owner ? `${owner.user.tag}` : 'Unknown',                     inline: true },
                { name: 'Members',     value: `\`${guild.memberCount.toLocaleString()}\``,                  inline: true },
                { name: 'Created',     value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`,         inline: true },
                { name: 'Text Channels',  value: `\`${textChannels}\``,                                     inline: true },
                { name: 'Voice Channels', value: `\`${voiceChannels}\``,                                    inline: true },
                { name: 'Roles',       value: `\`${guild.roles.cache.size}\``,                               inline: true },
                { name: 'Boost Level', value: `\`Tier ${guild.premiumTier || 0}\` (\`${guild.premiumSubscriptionCount || 0}\` boosts)`, inline: true },
                { name: 'Server ID',   value: `\`${guild.id}\``,                                             inline: true },
            )
            .setFooter(FOOTER)
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    };
}

module.exports = createServerInfoHandler;
