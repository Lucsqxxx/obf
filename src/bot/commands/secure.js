// ═══════════════════════════════════════════════════════════════
//  UmbraX — .secure Command
//  Obfuscate + ID-lock + host on Rubis
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const crypto = require('crypto');
const { parseLayerFlags } = require('../helpers');
const { buildSecureLoader } = require('../idguard');
const { uploadToRubis } = require('../rubis');
const { uploadToPastefy } = require('../pastefy');

/**
 * Factory — call once at startup with shared bot dependencies.
 *
 * @param {{
 *   transformer : import('../transformer'),
 *   validator   : import('../validator'),
 *   store       : import('../store'),
 *   usageStats  : { total: number, totalBytes: number, errors: number, users: Set },
 *   C           : Record<string, number>,
 *   BRAND       : string,
 *   FOOTER      : { text: string },
 *   formatBytes : (n: number) => string,
 *   bar         : (v: number, m: number, l?: number) => string,
 *   protectionLevel: (size: number) => { label: string, emoji: string, color: number },
 *   fetchSource : (msg, args) => Promise<{ source?: string, fileName?: string, error?: string }>,
 *   checkCooldown: (userId: string) => { remaining: number },
 *   setCooldown  : (userId: string) => void,
 * }} deps
 * @returns {(message: import('discord.js').Message, args: string[]) => Promise<void>}
 */
function createSecureHandler(deps) {
    const {
        transformer, validator, store, usageStats,
        C, BRAND, FOOTER, COOLDOWN_MS,
        formatBytes, bar, protectionLevel,
        fetchSource, checkCooldown, setCooldown,
    } = deps;

    // ── Embed helpers (local to this command) ──────────────────
    const errorEmbed = (title, desc) =>
        new EmbedBuilder()
            .setColor(C.error)
            .setTitle(`\`❌\` ${title}`)
            .setDescription(desc)
            .setFooter(FOOTER)
            .setTimestamp();

    const pendingEmbed = (desc) =>
        new EmbedBuilder()
            .setColor(C.main)
            .setDescription(desc);

    // ── Main handler ───────────────────────────────────────────
    return async function handleSecure(message, args) {
        // Optional HWID binding: `.secure hwid:<value> [code]`. Pull it out of
        // args before the shared flag parser runs so it isn't treated as code,
        // then delegate the --cff/--split/--deep/--indirect flags to the same
        // parser .obfuscate uses (so the two commands never drift).
        let hwid = null;
        const preArgs = [];
        for (const a of (args || [])) {
            const m = /^hwid:(.+)$/i.exec(a);
            if (m) { hwid = m[1]; continue; }
            preArgs.push(a);
        }
        const { layers, args: filteredArgs } = parseLayerFlags(preArgs);
        args = filteredArgs;

        // 1. Resolve source (file or inline) via shared helper
        const result = await fetchSource(message, args);
        if (result.error) {
            return message.reply({ embeds: [errorEmbed('No Input', result.error)] });
        }

        const { source, fileName } = result;

        if (!source || source.trim().length === 0) {
            return message.reply({ embeds: [errorEmbed('Empty Input', 'The provided script is empty.')] });
        }

        // 2. Cooldown (shared helper — no duplication)
        const userId = message.author.id;
        const { remaining } = checkCooldown(userId);
        if (remaining > 0) {
            return message.reply({
                embeds: [errorEmbed(
                    'Cooldown',
                    `Please wait **${Math.ceil(remaining / 1000)}s** before using this again.\n\n` +
                    `\`${bar(COOLDOWN_MS - remaining, COOLDOWN_MS, 20)}\``
                )],
            });
        }
        setCooldown(userId);

        const statusMsg = await message.reply({
            embeds: [pendingEmbed('⏳ Securing your script — generating ID, obfuscating, and uploading...')],
        });

        try {
            // 3. Syntax validation (on the original source, before the guard is prepended)
            const check = validator.validate(source);
            if (!check.valid) {
                usageStats.errors++;
                const errorList = check.errors.slice(0, 5).map(e => `\`•\` ${e}`).join('\n');
                return statusMsg.edit({
                    embeds: [errorEmbed('Syntax Error', `Your code has syntax errors:\n\n${errorList}`)],
                });
            }

            // 4. Generate the script ID (the decryption credential)
            const scriptId = `UMBRX-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

            // 5. Obfuscate the ORIGINAL source, then wrap the obfuscated blob in
            //    the credential-keyed self-decrypting loader. The credential is
            //    the decryption key — there is no boolean check to strip; a wrong
            //    or missing script_id decrypts to garbage that won't loadstring.
            const t0 = Date.now();
            const obfuscated = transformer.transform(source, {
                renameVariables: true,
                addJunkCode:     true,
                encodeNumbers:   true,
                minStringLength: 1,
                // Off by default — see the same note in obfuscate.js.
                watermark:       false,
                ...layers,
            });
            const stats   = transformer.getStats();
            // The payload the user actually loads: obfuscated script, encrypted
            // under the script_id (+HWID). This is what gets hosted / attached.
            const secured = buildSecureLoader(scriptId, hwid, obfuscated);
            const elapsed = Date.now() - t0;

            // 6. Update stats (obfuscation already succeeded) and persist —
            //    .obfuscate saves here too; .secure previously relied on a later
            //    command or the shutdown flush, so a crash lost the stats.
            usageStats.total++;
            usageStats.totalBytes += stats.bytesOutput;
            usageStats.guardsDeployed += stats.antiTamperChecks || 0;
            usageStats.users.add(userId);
            store.save();

            const level     = protectionLevel(stats.bytesOutput);
            const baseName  = fileName ? fileName.replace(/\.(txt|luau?)$/i, '.lua') : 'script.lua';

            // 7. Attempt to host on both Rubis and Pastefy — but never let an
            //    upload failure throw away a successful obfuscation. Fall back
            //    to delivering the obfuscated .lua directly (the ID guard is
            //    baked into it) only if BOTH hosts are down.
            let uploadErr = null;
            const [rubis, pastefy] = await Promise.all([
                uploadToRubis(secured, 'UmbraX Secured Script').catch((err) => {
                    uploadErr = err;
                    console.error('[UmbraX] .secure Rubis upload failed:', err.message);
                    return null;
                }),
                uploadToPastefy(secured, 'UmbraX Secured Script').catch((err) => {
                    uploadErr = err;
                    console.error('[UmbraX] .secure Pastefy upload failed:', err.message);
                    return null;
                }),
            ]);

            if (rubis || pastefy) {
                // ── Hosted path ──────────────────────────────────────
                // Primary loader uses whichever host is up (Rubis preferred).
                const primary = rubis || pastefy;
                const loader = [
                    `getgenv().script_id = "${scriptId}"`,
                    `loadstring(game:HttpGet("${primary.rawUrl}"))()`,
                ].join('\n');

                // List every host it landed on, each with a tap-to-copy loader.
                const hostLines = [];
                if (rubis)   hostLines.push(`**Rubis** — [view](${rubis.viewUrl}) · \`\`getgenv().script_id = "${scriptId}"\nloadstring(game:HttpGet("${rubis.rawUrl}"))()\`\``);
                if (pastefy) hostLines.push(`**Pastefy** — [view](${pastefy.viewUrl}) · \`\`getgenv().script_id = "${scriptId}"\nloadstring(game:HttpGet("${pastefy.rawUrl}"))()\`\``);

                const embed = new EmbedBuilder()
                    .setColor(C.cyan)
                    .setAuthor({ name: BRAND })
                    .setTitle('`🔐` Script Secured & Hosted')
                    .setDescription(
                        `\`${formatBytes(stats.bytesOriginal)}\` → \`${formatBytes(stats.bytesOutput)}\` • ID-locked.\n\n` +
                        `Tap to copy the loader:\n\`\`${loader}\`\``,
                    )
                    .addFields(
                        { name: 'Script ID', value: `\`${scriptId}\``, inline: false },
                        { name: 'Hosts',     value: hostLines.join('\n'), inline: false },
                    )
                    .setFooter({ text: `${FOOTER.text} • won't run without the correct script_id` })
                    .setTimestamp();

                const loaderAttachment = new AttachmentBuilder(Buffer.from(loader, 'utf-8'), { name: `secured_${baseName}` });
                await statusMsg.edit({ embeds: [embed], files: [loaderAttachment] });

            } else {
                // ── Fallback path: deliver the obfuscated file directly ──
                const isTimeout = uploadErr && uploadErr.name === 'AbortError';
                const embed = new EmbedBuilder()
                    .setColor(C.warn)
                    .setAuthor({ name: BRAND })
                    .setTitle('`🔐` Script Secured — Hosting Unavailable')
                    .setDescription(
                        `\`${formatBytes(stats.bytesOriginal)}\` → \`${formatBytes(stats.bytesOutput)}\` • ID-locked & obfuscated, but the Rubis host was ` +
                        (isTimeout ? 'unreachable (timeout)' : 'unavailable') +
                        '. The obfuscated script is attached — host it yourself.'
                    )
                    .addFields(
                        { name: 'Script ID', value: `\`${scriptId}\``, inline: false },
                        {
                            name:   'How to use',
                            value:  'The attached `.lua` already contains the ID guard. Host it, then load with (tap to copy):\n' +
                                    `\`\`getgenv().script_id = "${scriptId}"\nloadstring(game:HttpGet("YOUR_URL"))()\`\``,
                            inline: false,
                        },
                    )
                    .setFooter({ text: FOOTER.text })
                    .setTimestamp();

                const obfAttachment = new AttachmentBuilder(Buffer.from(secured, 'utf-8'), { name: `secured_${baseName}` });
                await statusMsg.edit({ embeds: [embed], files: [obfAttachment] });
            }

        } catch (err) {
            console.error('[UmbraX] .secure error:', err);
            await statusMsg.edit({
                embeds: [errorEmbed('Secure Failed', `Something went wrong during obfuscation.\n\n\`${err.message}\``)],
            });
        }
    };
}

module.exports = createSecureHandler;