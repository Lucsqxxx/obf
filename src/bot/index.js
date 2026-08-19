// ═══════════════════════════════════════════════════════════════
//  UmbraX — Discord bot entry point
//
//  Wiring only: construct the client + shared services, build the command
//  map (one factory per command in ./commands/), dispatch prefixed
//  messages, and persist state on shutdown. All command logic lives in
//  ./commands/*; pure helpers in ./helpers.js; config in ./constants.js.
//
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const { Client, GatewayIntentBits } = require('discord.js');

const LuaTransformer     = require('../obfuscator/transformer');
const ObfuscatorEngine   = require('../obfuscator/engine');
const LuaSyntaxValidator = require('../obfuscator/validator');
const LuaBeautifier      = require('../obfuscator/beautifier');
const minifier           = require('../obfuscator/minifier');
const nativetools        = require('../obfuscator/nativetools');
const store              = require('./store');
const config             = require('./config');

const { VERSION, PREFIX, COOLDOWN_MS, C, BRAND, FOOTER } = require('./constants');
const { formatBytes, bar, protectionLevel, fetchSource, errorEmbed, hasObfuscatorAccess, accessDeniedEmbed, hasStaffAccess, staffAccessDeniedEmbed } = require('./helpers');

const createObfuscateHandler = require('./commands/obfuscate');
const createEncryptHandler   = require('./commands/encrypt');
const createBeautifyHandler  = require('./commands/beautify');
const createMinifyHandler    = require('./commands/minify');
const createPingHandler      = require('./commands/ping');
const createHelpHandler      = require('./commands/help');
const createPanelHandler     = require('./commands/panel');
const createSecureHandler    = require('./commands/secure');
const createUploadHandler    = require('./commands/upload');
const createStatsHandler     = require('./commands/stats');
const createModerationHandlers = require('./commands/moderation');
const createUpdateHandler    = require('./commands/update');
const createEmbedHandler     = require('./commands/embed');
const createTicketHandlers   = require('./commands/ticket');
const createGiveawayHandlers = require('./commands/giveaway');
const createApplicationHandlers = require('./commands/application');
const createInteractiveBuilder = require('./commands/embedbuilder');

// ── Services ─────────────────────────────────────────────────────
const client      = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });
const transformer = new LuaTransformer();
const engine      = new ObfuscatorEngine();
const validator   = new LuaSyntaxValidator();
const beautifier  = new LuaBeautifier();

const startTime = Date.now();
// Cooldowns + stats persist across restarts (see store.js) so the cooldown
// can't be bypassed by restarting and lifetime stats survive.
const usageStats = store.stats;

// ── Cooldown helpers (bound to the persistent store) ─────────────
function checkCooldown(userId) {
    const last      = store.getCooldown(userId);
    const remaining = COOLDOWN_MS - (Date.now() - last);
    return { remaining: Math.max(0, remaining) };
}
function setCooldown(userId) {
    store.setCooldown(userId, Date.now());
}

// ── Command wiring ───────────────────────────────────────────────
// Dependency bundle for the .secure factory (keeps its original shape).
const secureDeps = {
    transformer, validator, store, usageStats,
    C, BRAND, FOOTER, COOLDOWN_MS,
    formatBytes, bar, protectionLevel,
    fetchSource, checkCooldown, setCooldown,
};

// Shared interactive live-preview builder — used by .embed / .update /
// .giveaway / .ticket when invoked with no arguments.
const builder = createInteractiveBuilder({ C, BRAND, FOOTER });

const moderation = createModerationHandlers({ C, BRAND, FOOTER, store });
const tickets    = createTicketHandlers({ C, BRAND, FOOTER, config, store, hasStaffAccess, errorEmbed, staffAccessDeniedEmbed, builder });
const giveaways  = createGiveawayHandlers({ C, BRAND, FOOTER, store, client, config, hasStaffAccess, errorEmbed, staffAccessDeniedEmbed, builder });
const applications = createApplicationHandlers({ C, BRAND, FOOTER, config, store, client, hasStaffAccess, errorEmbed, staffAccessDeniedEmbed });

const commands = new Map([
    ['obfuscate', createObfuscateHandler({ transformer, validator, store, usageStats, checkCooldown, setCooldown })],
    ['encrypt',   createEncryptHandler({ engine, store, usageStats })],
    ['beautify',  createBeautifyHandler({ beautifier, nativetools })],
    ['minify',    createMinifyHandler({ nativetools, minifier })],
    ['ping',      createPingHandler({ client, startTime })],
    ['help',      createHelpHandler()],
    ['panel',     createPanelHandler()],
    ['secure',    createSecureHandler(secureDeps)],
    ['upload',    createUploadHandler({ usageStats, store })],
    ['stats',     createStatsHandler({ usageStats, store, startTime })],
    // ── Community moderation (gated by Discord permissions per-command) ──
    ['clear',     moderation.clear],
    ['purge',     moderation.clear],
    ['kick',      moderation.kick],
    ['ban',       moderation.ban],
    ['timeout',   moderation.timeout],
    ['mute',      moderation.timeout],
    ['warn',      moderation.warn],
    ['warnings',  moderation.warnings],
    ['warns',     moderation.warnings],
    ['unwarn',    moderation.unwarn],
    // ── Staff management (gated by the manager role; hidden from .help/.panel) ──
    ['update',    createUpdateHandler({ builder })],
    ['embed',     createEmbedHandler({ builder })],
    ['ticket',    tickets.ticket],
    ['giveaway',  giveaways.giveaway],
    ['gw',        giveaways.giveaway],
    ['application', applications.application],
]);

// Commands that require the obfuscator role (config.obfuscatorRoleId). Everything
// else (help, panel, ping, stats, moderation) is open or self-gated by perms.
const OBFUSCATOR_COMMANDS = new Set(['obfuscate', 'secure', 'upload', 'encrypt', 'beautify', 'minify']);

// Staff-only management commands. Gated by the manager role (config.managerRoleId)
// and hidden from .help/.panel unless the invoker has staff access.
const STAFF_COMMANDS = new Set(['update', 'embed', 'ticket', 'giveaway', 'gw', 'application']);

// ── Lifecycle ────────────────────────────────────────────────────
client.once('ready', () => {
    console.log(`[UmbraX] ✓ Logged in as ${client.user.tag}`);
    console.log(`[UmbraX] ✓ v${VERSION} ready — ${commands.size} commands`);
    client.user.setPresence({
        activities: [{ name: '.obfuscate • anti-tamper', type: 3 }],
        status: 'dnd',
    });
    // Re-arm giveaway end-timers that were running before this restart.
    try { giveaways.rehydrate(); } catch (err) { console.warn('[UmbraX] giveaway rehydrate failed:', err.message); }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args    = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    const handler = commands.get(command);
    if (!handler) return;

    // Gate the obfuscator commands behind the configured role (if any).
    if (OBFUSCATOR_COMMANDS.has(command) && !hasObfuscatorAccess(message, config.obfuscatorRoleId)) {
        return message.reply({ embeds: [accessDeniedEmbed(config.obfuscatorRoleId)] }).catch(() => {});
    }

    // Gate the staff management commands behind the manager role. These are
    // also hidden from .help/.panel for non-staff (see the handlers).
    if (STAFF_COMMANDS.has(command) && !hasStaffAccess(message, config.managerRoleId)) {
        return message.reply({ embeds: [staffAccessDeniedEmbed(config.managerRoleId)] }).catch(() => {});
    }

    try {
        await handler(message, args);
    } catch (err) {
        console.error(`[UmbraX] Error in .${command}:`, err);
        await message.reply({
            embeds: [errorEmbed('Internal Error', 'An unexpected error occurred. Please try again.')],
        }).catch(() => {});
    }
});

// Button clicks are offered to each feature module in turn; the first one that
// recognises the customId handles it and returns true.
client.on('interactionCreate', async interaction => {
    try {
        // The shared builder owns its own `umbrax_ib:` namespace — offer it first.
        if (await builder.handleInteraction(interaction)) return;
        if (await tickets.handleInteraction(interaction)) return;
        if (await giveaways.handleInteraction(interaction)) return;
        if (await applications.handleInteraction(interaction)) return;
    } catch (err) {
        console.error('[UmbraX] Error in interaction:', err);
        if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
            interaction.reply({ content: 'Something went wrong handling that action.', ephemeral: true }).catch(() => {});
        }
    }
});

// Flush persisted state on shutdown so nothing in the debounce window is lost.
function gracefulExit() {
    try { store.flushNow(); } catch {}
    process.exit(0);
}
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

client.login(config.token);
