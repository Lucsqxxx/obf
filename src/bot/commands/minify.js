// ═══════════════════════════════════════════════════════════════
//  UmbraX — .minify command
//  Shrink Luau source with darklua (preferred) or luau_beautifier --minify.
//  Both are OPTIONAL native binaries; if neither is installed the command
//  reports that cleanly instead of failing (see nativetools.js discovery).
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { formatBytes, fetchSource, errorEmbed } = require('../helpers');

/**
 * @param {{ nativetools, minifier? }} deps
 */
function createMinifyHandler(deps) {
    const { nativetools, minifier } = deps;

    return async function handleMinify(message, args) {
        const result = await fetchSource(message, args);
        if (result.error) {
            return message.reply({ embeds: [errorEmbed('No Input', result.error)] });
        }
        const { source, fileName } = result;
        if (!source || source.trim().length === 0) {
            return message.reply({ embeds: [errorEmbed('Empty Input', 'The provided code is empty.')] });
        }

        // Engine ladder: prefer darklua (purpose-built), then luau_beautifier's
        // minify mode, and finally the built-in pure-JS minifier, which always
        // works and needs no external tooling. Each native step is skipped if
        // its binary is absent or the run fails, so the built-in is a safe last
        // resort — the command can never be "unavailable".
        let out, engineName;
        if (nativetools.isAvailable('darklua')) {
            out = nativetools.runDarkluaMinify(source);
            engineName = 'darklua';
        } else if (nativetools.isAvailable('luauBeautifier')) {
            out = nativetools.runLuauBeautifier(source, { minify: true });
            engineName = 'luau_beautifier';
        }

        // Native engine absent or it failed → built-in fallback.
        if ((!out || !out.ok) && minifier) {
            try {
                out = { ok: true, output: minifier.minify(source) };
                engineName = 'built-in';
            } catch (err) {
                out = { ok: false, reason: 'error', error: err.message };
            }
        }

        if (!out) {
            return message.reply({ embeds: [errorEmbed(
                'Minifier Unavailable',
                'No minifier engine is available on the host.',
            )] });
        }
        if (!out.ok) {
            return message.reply({ embeds: [errorEmbed(
                'Minify Failed',
                `\`${(out.error || 'unknown error').split('\n')[0].slice(0, 400)}\``,
            )] });
        }

        const minified = out.output;
        const saved    = source.length - minified.length;
        const pct      = source.length > 0 ? ((saved / source.length) * 100) : 0;

        const embed = new EmbedBuilder()
            .setColor(C.cyan)
            .setAuthor({ name: BRAND })
            .setTitle('`🗜️` Code Minified')
            .setDescription(
                `**${formatBytes(source.length)}** → **${formatBytes(minified.length)}** ` +
                `(${pct >= 0 ? '−' : '+'}${Math.abs(pct).toFixed(1)}%) via \`${engineName}\`.`,
            )
            .setFooter(FOOTER)
            .setTimestamp();

        if (minified.length > 1900) {
            const attachment = new AttachmentBuilder(
                Buffer.from(minified, 'utf-8'),
                { name: fileName ? `min_${fileName}` : 'minified.lua' },
            );
            await message.reply({ embeds: [embed], files: [attachment] });
        } else {
            embed.addFields({ name: '📄 Output', value: '```lua\n' + minified.substring(0, 1000) + '\n```', inline: false });
            await message.reply({ embeds: [embed] });
        }
    };
}

module.exports = createMinifyHandler;
