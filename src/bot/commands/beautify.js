// ═══════════════════════════════════════════════════════════════
//  UmbraX — .beautify command
//  Reformat Lua with proper indentation and spacing.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { formatBytes, fetchSource, errorEmbed } = require('../helpers');

/**
 * @param {{ beautifier, nativetools? }} deps
 */
function createBeautifyHandler(deps) {
    const { beautifier, nativetools } = deps;

    return async function handleBeautify(message, args) {
        const result = await fetchSource(message, args);
        if (result.error) {
            return message.reply({ embeds: [errorEmbed('No Input', result.error)] });
        }
        const { source, fileName } = result;
        if (!source || source.trim().length === 0) {
            return message.reply({ embeds: [errorEmbed('Empty Input', 'The provided code is empty.')] });
        }

        // Engine ladder: prefer luau_beautifier, then luau-format (both give
        // fuller Luau grammar support than the built-in), and finally fall back
        // to the built-in pure-JS beautifier, which always works and needs no
        // external tooling. Each native step is skipped if its binary is absent
        // or the run fails, so the built-in is always a safe last resort.
        let formatted;
        let engineName = 'built-in';
        if (nativetools && nativetools.isAvailable('luauBeautifier')) {
            const nb = nativetools.runLuauBeautifier(source, {});
            if (nb.ok) { formatted = nb.output; engineName = 'luau_beautifier'; }
        }
        if (formatted === undefined && nativetools && nativetools.isAvailable('luauFormat')) {
            const lf = nativetools.runLuauFormat(source, {});
            if (lf.ok) { formatted = lf.output; engineName = 'luau-format'; }
        }
        if (formatted === undefined) {
            try {
                formatted = beautifier.beautify(source);
            } catch (err) {
                return message.reply({ embeds: [errorEmbed('Beautify Failed', `\`${err.message}\``)] });
            }
        }

        const embed = new EmbedBuilder()
            .setColor(C.cyan)
            .setAuthor({ name: BRAND })
            .setTitle('`✨` Code Beautified')
            .setDescription(`Reformatted **${formatBytes(source.length)}** of Lua with proper indentation via \`${engineName}\`.`)
            .setFooter(FOOTER)
            .setTimestamp();

        if (formatted.length > 1900) {
            const attachment = new AttachmentBuilder(
                Buffer.from(formatted, 'utf-8'),
                { name: fileName ? `pretty_${fileName}` : 'beautified.lua' }
            );
            await message.reply({ embeds: [embed], files: [attachment] });
        } else {
            embed.addFields({ name: '📄 Output', value: '```lua\n' + formatted.substring(0, 1000) + '\n```', inline: false });
            await message.reply({ embeds: [embed] });
        }
    };
}

module.exports = createBeautifyHandler;
