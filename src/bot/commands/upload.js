// ═══════════════════════════════════════════════════════════════
//  UmbraX — .upload command
//  Host raw Luau on Rubis and return a ready-to-run loadstring loader:
//    loadstring(game:HttpGet("<rubis raw url>"))()
//  No obfuscation, no ID lock — a straight "paste code, get a link"
//  helper. For protected hosting use .secure instead.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { C, BRAND, FOOTER } = require('../constants');
const { formatBytes, fetchSource, errorEmbed } = require('../helpers');
const { uploadToRubis } = require('../rubis');
const { uploadToPastefy } = require('../pastefy');

/**
 * @param {{ usageStats: { errors: number, uploads: number }, store?: { save: Function } }} deps
 */
function createUploadHandler(deps) {
    const { usageStats, store } = deps;

    return async function handleUpload(message, args) {
        // Resolve source (inline code or attached .lua/.luau/.txt).
        const result = await fetchSource(message, args);
        if (result.error) {
            return message.reply({ embeds: [errorEmbed('No Input', result.error)] });
        }
        const { source, fileName } = result;
        if (!source || source.trim().length === 0) {
            return message.reply({ embeds: [errorEmbed('Empty Input', 'The provided code is empty.')] });
        }

        const statusMsg = await message.reply({
            embeds: [new EmbedBuilder().setColor(C.main).setDescription('⏳ Uploading your script to Rubis...')],
        });

        // Host on both Rubis and Pastefy in parallel — the user picks whichever
        // their executor reaches. Neither failing alone aborts the upload; only
        // if BOTH are down do we surface an error.
        const [rubis, pastefy] = await Promise.all([
            uploadToRubis(source, 'UmbraX Upload').catch((err) => {
                console.error('[UmbraX] .upload Rubis upload failed:', err.message);
                return null;
            }),
            uploadToPastefy(source, 'UmbraX Upload').catch((err) => {
                console.error('[UmbraX] .upload Pastefy upload failed:', err.message);
                return null;
            }),
        ]);

        if (!rubis && !pastefy) {
            usageStats.errors++;
            return statusMsg.edit({
                embeds: [errorEmbed(
                    'Upload Failed',
                    'Both hosts (Rubis and Pastefy) were unreachable. Please try again.',
                )],
            });
        }

        usageStats.uploads++;
        if (store && store.save) store.save();

        // Prefer Rubis as the primary loader (its raw endpoint is HttpGet-friendly),
        // falling back to Pastefy if Rubis was the one that failed.
        const primary = rubis || pastefy;
        const loader = `loadstring(game:HttpGet("${primary.rawUrl}"))()`;

        // One "Hosts" field lists every place it landed, tap-to-copy loader each.
        const hostLines = [];
        if (rubis)   hostLines.push(`**Rubis** — [view](${rubis.viewUrl}) · \`\`loadstring(game:HttpGet("${rubis.rawUrl}"))()\`\``);
        if (pastefy) hostLines.push(`**Pastefy** — [view](${pastefy.viewUrl}) · \`\`loadstring(game:HttpGet("${pastefy.rawUrl}"))()\`\``);

        const embed = new EmbedBuilder()
            .setColor(C.cyan)
            .setAuthor({ name: BRAND })
            .setTitle('`📤` Script Uploaded')
            .setDescription(
                `Hosted — tap a loader to copy it.\n\n` +
                `\`\`${loader}\`\``,
            )
            .addFields({
                name:  'Hosts',
                value: `${hostLines.join('\n')}\n\nPlain, un-obfuscated upload — use \`.secure\` for protected hosting.`,
                inline: false,
            })
            .setFooter({ text: `${FOOTER.text} • ${formatBytes(Buffer.byteLength(source, 'utf-8'))}` })
            .setTimestamp();

        const loaderAttachment = new AttachmentBuilder(
            Buffer.from(loader, 'utf-8'),
            { name: fileName ? `loader_${fileName.replace(/\.(txt|luau?)$/i, '.lua')}` : 'loader.lua' },
        );
        await statusMsg.edit({ embeds: [embed], files: [loaderAttachment] });
    };
}

module.exports = createUploadHandler;
