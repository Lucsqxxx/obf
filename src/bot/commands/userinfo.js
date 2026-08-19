// ═══════════════════════════════════════════════════════════════
//  UmbraX — .userinfo command
//  At-a-glance info about a member (defaults to yourself).
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { errorEmbed } = require('../helpers');

function createUserInfoHandler() {
    return async function handleUserInfo(message, args) {
        if (!message.guild) return message.reply({ embeds: [errorEmbed('Guild Only', 'This command only works in a server.')] });

        // Mentioned member, or an ID as the first arg, or the caller themselves.
        let target = message.mentions?.members?.first?.() || null;
        if (!target) {
            const id = (args[0] || '').replace(/[<@!>]/g, '');
            if (/^\d{16,20}$/.test(id)) target = await message.guild.members.fetch(id).catch(() => null);
        }
        target = target || message.member;
        if (!target) return message.reply({ embeds: [errorEmbed('Not Found', 'Could not resolve that member.')] });

        const roles = target.roles.cache
            .filter(r => r.id !== message.guild.id)
            .sort((a, b) => b.position - a.position);
        const roleText = roles.size ? [...roles.values()].slice(0, 15).map(r => `${r}`).join(' ') : 'None';

        const embed = new EmbedBuilder()
            .setColor(target.displayColor || C.main)
            .setAuthor({ name: BRAND })
            .setTitle(`\`👤\` ${target.user.tag}`)
            .setThumbnail(target.user.displayAvatarURL({ size: 256 }))
            .addFields(
                { name: 'ID',              value: `\`${target.id}\``,                                                 inline: true },
                { name: 'Bot?',            value: target.user.bot ? 'Yes' : 'No',                                     inline: true },
                { name: 'Joined Server',   value: target.joinedTimestamp ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
                { name: 'Account Created', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`,          inline: true },
                { name: `Roles [${roles.size}]`, value: roleText, inline: false },
            )
            .setFooter(FOOTER)
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    };
}

module.exports = createUserInfoHandler;
