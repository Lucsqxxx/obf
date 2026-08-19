// ═══════════════════════════════════════════════════════════════
//  UmbraX — .panel command
//  A clean, at-a-glance panel of every obfuscator command. Meant as
//  the quick "what can this thing do" card for the community server,
//  where the obfuscator is only one part of the bot.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { hasStaffAccess } = require('../helpers');
const config = require('../config');

function createPanelHandler() {
    return async function handlePanel(message) {
        const embed = new EmbedBuilder()
            .setColor(C.main)
            .setAuthor({ name: BRAND })
            .setTitle('`🎛️` Obfuscator Panel')
            .setDescription('Everything the UmbraX obfuscator can do. Attach a `.lua`/`.luau`/`.txt` file or paste code after the command.')
            .addFields(
                {
                    name:  '🛡️ Protect',
                    value: [
                        '`.obfuscate` — Obfuscate + anti-tamper loader',
                        '`.secure` — Obfuscate, ID-lock & host',
                        '`.encrypt` — Encrypt a single string',
                    ].join('\n'),
                    inline: true,
                },
                {
                    name:  '🧰 Transform',
                    value: [
                        '`.beautify` — Reformat & indent',
                        '`.minify` — Shrink / strip whitespace',
                        '`.upload` — Host raw + get a loader',
                    ].join('\n'),
                    inline: true,
                },
                {
                    name:  '⚙️ Layers (add to `.obfuscate` / `.secure`)',
                    value: '`--cff` `--split` `--deep` `--indirect` `--pool`',
                    inline: false,
                },
                {
                    name:  '🔧 Utility',
                    value: '`.serverinfo` · `.userinfo` `[@user]` · `.stats` · `.ping`',
                    inline: false,
                },
            )
            .setFooter({ text: `${FOOTER.text} • .help for full details` })
            .setTimestamp();

        // Reveal the staff management tools only to members with staff access.
        if (hasStaffAccess(message, config.managerRoleId)) {
            embed.addFields({
                name:  '🛠️ Management (staff)',
                value: [
                    '`.say` — Post plain text as the bot',
                    '`.update` — Post an update announcement',
                    '`.embed` — Build a custom embed',
                    '`.ticket setup` — Support-ticket panel',
                    '`.giveaway start` — Run a giveaway',
                    '`.application panel` — Staff-application panel',
                    '`.lock` / `.unlock` / `.slowmode` — Channel controls',
                ].join('\n'),
                inline: false,
            });
        }

        await message.reply({ embeds: [embed] });
    };
}

module.exports = createPanelHandler;
