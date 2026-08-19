// ═══════════════════════════════════════════════════════════════
//  UmbraX — .help command
//  Command reference + usage tips.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, BRAND, FOOTER, COOLDOWN_MS, MAX_FILE_SIZE } = require('../constants');
const { formatBytes, hasStaffAccess } = require('../helpers');
const config = require('../config');

function createHelpHandler() {
    return async function handleHelp(message) {
        const embed = new EmbedBuilder()
            .setColor(C.main)
            .setAuthor({ name: BRAND })
            .setTitle('`📖` Command Reference')
            .setDescription('Advanced Luau Obfuscation Engine — *by Lucsqx*')
            .addFields(
                {
                    name:  '🔮 Obfuscator',
                    value: [
                        '`.obfuscate` — Obfuscate + anti-tamper loader',
                        '`.secure` — Obfuscate, ID-lock & host',
                        '`.upload` — Host as-is + loadstring loader',
                        '`.encrypt` — Encrypt a single string',
                        '`.beautify` · `.minify` — Reformat / shrink',
                        '`.panel` — Obfuscator quick-panel',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name:  '🛡️ Moderation (staff)',
                    value: [
                        '`.clear` `<1-100> [@user]` · `.kick` · `.ban` · `.unban` `<id>`',
                        '`.timeout` `@user <10m|1h|1d>` · `.warn` `@user`',
                        '`.warnings` `@user` · `.unwarn` `@user [index|all]`',
                        '`.lock` · `.unlock` — Toggle a channel\'s send permission',
                        '`.slowmode` `<duration|off>` · `.nick` `@user [name]`',
                    ].join('\n'),
                    inline: false,
                },
                {
                    name:  '🔧 Utility',
                    value: '`.stats` · `.ping` · `.help` · `.serverinfo` · `.userinfo` `[@user]`',
                    inline: false,
                },
                {
                    name:  '💡 Tips',
                    value: [
                        `Flags: \`--cff --split --deep --indirect --pool\``,
                        `Attach a \`.lua\`/\`.luau\`/\`.txt\` for larger scripts · \`.secure hwid:<id>\` binds a HWID`,
                        `Cooldown \`${COOLDOWN_MS / 1000}s\` · Max file \`${formatBytes(MAX_FILE_SIZE)}\``,
                    ].join('\n'),
                    inline: false,
                }
            )
            .setFooter(FOOTER)
            .setTimestamp();

        // Staff-only management commands are shown ONLY to members with staff
        // access, so regular members never see (or discover) them in .help.
        if (hasStaffAccess(message, config.managerRoleId)) {
            embed.addFields({
                name:  '```🛠️ Management (staff)```',
                value: [
                    '> `.say` `<message>` — Post plain text as the bot',
                    '> `.update` `<version> [#channel] [noping]` `<changelog…>` — Post an update announcement',
                    '> `.embed` `<key: value…>` — Build/edit an embed (`channel:` `edit:` `timestamp:`)',
                    '> `.ticket setup` — Post the support-ticket panel',
                    '> `.ticket close` `/add @user` `/remove @user` — Manage a ticket',
                    '> `.giveaway` — Start a giveaway with the live-preview builder',
                    '> `.giveaway start` `<time>` `<winners>` `<prize>` — Start one directly',
                    '> `.giveaway end|reroll|list` — Manage giveaways',
                    '> `.application add` — Configure an application position',
                    '> `.application panel|list|remove` — Manage & post applications',
                ].join('\n'),
                inline: false,
            });
        }

        await message.reply({ embeds: [embed] });
    };
}

module.exports = createHelpHandler;
