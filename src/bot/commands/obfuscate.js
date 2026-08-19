// ═══════════════════════════════════════════════════════════════
//  UmbraX — .obfuscate command
//  Obfuscate + wrap in the self-decrypting, anti-tampered loader.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { C, BRAND, FOOTER, COOLDOWN_MS } = require('../constants');
const {
    parseLayerFlags, formatBytes, bar, protectionLevel, fetchSource, errorEmbed,
} = require('../helpers');

/**
 * @param {{ transformer, validator, store, usageStats,
 *           checkCooldown: (id)=>{remaining:number}, setCooldown: (id)=>void }} deps
 */
function createObfuscateHandler(deps) {
    const { transformer, validator, store, usageStats, checkCooldown, setCooldown } = deps;

    return async function handleObfuscate(message, args) {
        const { layers, args: cleanArgs } = parseLayerFlags(args);
        args = cleanArgs;
        const result = await fetchSource(message, args);
        if (result.error) {
            return message.reply({ embeds: [errorEmbed('No Input', result.error)] });
        }

        const userId = message.author.id;
        const { remaining } = checkCooldown(userId);
        if (remaining > 0) {
            return message.reply({
                embeds: [errorEmbed('Cooldown', `Please wait **${Math.ceil(remaining / 1000)}s** before obfuscating again.\n\n\`${bar(COOLDOWN_MS - remaining, COOLDOWN_MS, 20)}\``)],
            });
        }
        setCooldown(userId);

        const { source, fileName } = result;
        if (!source || source.trim().length === 0) {
            return message.reply({ embeds: [errorEmbed('Empty Input', 'The provided code is empty.')] });
        }

        const statusMsg = await message.reply({
            embeds: [new EmbedBuilder().setColor(C.main).setDescription('⏳ Obfuscating your script...')],
        });

        const check = validator.validate(source);
        if (!check.valid) {
            usageStats.errors++;
            const errorList = check.errors.slice(0, 5).map(e => `\`•\` ${e}`).join('\n');
            return statusMsg.edit({
                embeds: [errorEmbed('Syntax Error', `Your code has syntax errors:\n\n${errorList}`)],
            });
        }

        const t0 = Date.now();
        let obfuscated, stats;
        try {
            obfuscated = transformer.transform(source, {
                renameVariables: true,
                addJunkCode:     true,
                encodeNumbers:   true,
                minStringLength: 1,
                watermark:       true,
                ...layers,
            });
            stats = transformer.getStats();
        } catch (err) {
            usageStats.errors++;
            console.error('[UmbraX] transform error:', err);
            return statusMsg.edit({ embeds: [errorEmbed('Obfuscation Failed', `\`${err.message}\``)] });
        }
        const elapsed = Date.now() - t0;

        usageStats.total++;
        usageStats.totalBytes += stats.bytesOutput;
        usageStats.guardsDeployed += stats.antiTamperChecks || 0;
        usageStats.users.add(userId);
        store.save();

        const level = protectionLevel(stats.bytesOutput);

        const embed = new EmbedBuilder()
            .setColor(level.color)
            .setAuthor({ name: BRAND })
            .setTitle(`${level.emoji} Script Protected`)
            .setDescription(
                `\`${formatBytes(stats.bytesOriginal)}\` → \`${formatBytes(stats.bytesOutput)}\`  •  ` +
                `\`${stats.stringsEncrypted}\` strings  •  \`${elapsed}ms\``,
            )
            .setFooter({ text: FOOTER.text })
            .setTimestamp();

        if (obfuscated.length > 1900) {
            const attachment = new AttachmentBuilder(
                Buffer.from(obfuscated, 'utf-8'),
                { name: fileName ? `umbrax_${fileName}` : 'obfuscated.lua' }
            );
            await statusMsg.edit({ embeds: [embed], files: [attachment] });
        } else {
            embed.addFields({
                name:  '📄 Output',
                value: '```lua\n' + obfuscated.substring(0, 1000) + '\n```',
                inline: false,
            });
            await statusMsg.edit({ embeds: [embed] });
        }
    };
}

module.exports = createObfuscateHandler;
