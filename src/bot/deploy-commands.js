// ═══════════════════════════════════════════════════════════════
//  UmbraX — Deploy slash commands to Discord
//  Run once: node deploy-commands.js
// ═══════════════════════════════════════════════════════════════

const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('./config');

const commands = [
    // ── Protection ───────────────────────────────────────────
    new SlashCommandBuilder()
        .setName('obfuscate')
        .setDescription('🔮 Obfuscate Luau/Lua code with an anti-tampered loader')
        .addStringOption(opt =>
            opt.setName('code')
                .setDescription('Lua code to obfuscate (paste directly)')
                .setRequired(false))
        .addAttachmentOption(opt =>
            opt.setName('file')
                .setDescription('Upload a .lua/.luau file to obfuscate')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('encrypt')
        .setDescription('🔑 Encrypt a single string for manual embedding')
        .addStringOption(opt =>
            opt.setName('text')
                .setDescription('The string to encrypt')
                .setRequired(true)),

    // ── Info ─────────────────────────────────────────────────
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('🏓 Check bot latency and uptime'),

    new SlashCommandBuilder()
        .setName('help')
        .setDescription('📖 Show all available commands'),
];

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
    try {
        console.log(`[UmbraX] ⟳ Deploying ${commands.length} slash commands...`);
        await rest.put(
            Routes.applicationCommands(config.clientId),
            { body: commands.map(c => c.toJSON()) }
        );
        console.log(`[UmbraX] ✓ ${commands.length} commands deployed successfully`);
    } catch (err) {
        console.error('[UmbraX] ✗ Error:', err);
    }
})();
