// ═══════════════════════════════════════════════════════════════
//  UmbraX — .encrypt command
//  Encrypt a single string into a copy-paste, self-contained Lua snippet.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { errorEmbed } = require('../helpers');

/**
 * @param {{ engine, store, usageStats }} deps
 */
function createEncryptHandler(deps) {
    const { engine, store, usageStats } = deps;

    return async function handleEncrypt(message, args) {
        const text = args.join(' ');
        if (!text) {
            return message.reply({
                embeds: [errorEmbed('No Input', 'Provide a string to encrypt. Usage: `.encrypt <text>`')],
            });
        }

        const result = engine.encryptToLua(text);
        usageStats.encrypts++;
        store.save();

        // Build a self-contained Lua snippet: decrypt stub + the call returning
        // the original string. Copy-paste runs anywhere with bit32/string/table.
        const names = engine.decryptNames();
        const stub  = engine.emitDecryptStub(names);
        const expr  = `${stub}\nreturn ${names.DEC}("${result.escaped}",${result.key})`;

        const embed = new EmbedBuilder()
            .setColor(C.info)
            .setAuthor({ name: BRAND })
            .setTitle('`🔑` String Encrypted')
            .setDescription(`Encrypted **${text.length}** characters with key \`${result.key}\``)
            .addFields(
                { name: 'Input',       value: `\`\`\`${text.substring(0, 200)}\`\`\``,          inline: false },
                { name: 'Key',         value: `\`${result.key}\``,                               inline: true  },
                { name: 'Size',        value: `\`${text.length}\` → \`${result.length}\``,       inline: true  },
                { name: 'Entropy',     value: `\`${result.entropy}\` bits/byte`,                 inline: true  },
                { name: 'Lua Snippet', value: `\`\`\`lua\n${expr.substring(0, 900)}\n\`\`\``,   inline: false },
            )
            .setFooter(FOOTER)
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    };
}

module.exports = createEncryptHandler;
