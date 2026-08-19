// ═══════════════════════════════════════════════════════════════
//  UmbraX — Interactive builder (shared)
//
//  A reusable "fill-in-the-blanks with a LIVE PREVIEW" flow so staff don't
//  have to remember `key: value` syntax. A command opens a builder session
//  by handing this module a SPEC describing its fields; the module renders a
//  preview embed plus a control panel (edit modal, optional channel picker,
//  optional toggles, Post / Reset / Cancel) and drives the whole conversation
//  through Discord components. When the user presses Post, the spec's own
//  `submit()` performs the real action (post the embed, start the giveaway,
//  post the ticket panel, …).
//
//  The text `key: value` shortcut each command already supports is untouched:
//  a command opens the builder only when invoked with no arguments.
//
//  A SPEC looks like:
//    {
//      kind:  'embed',                 // customId namespace + panel title source
//      title: 'Embed Builder',         // shown on the control panel
//      accent: C.main,                 // control-panel color
//      fields: [                        // editable text fields (modal inputs)
//        { key, label, kind:'short'|'paragraph', placeholder, max, required, initial },
//      ],
//      groups: [{ label, keys:[...] }], // optional; how fields split across
//                                       // modals (≤5 inputs each). Defaults to
//                                       // auto-chunking fields into groups of 5.
//      toggles: [{ key, label, onText, offText, initial }],  // optional buttons
//      channelTarget: true,             // show a native channel picker
//      buildPreview(values, toggles, ctx) -> EmbedBuilder,   // never empty
//      previewContent(values, toggles, ctx) -> string|undefined,  // optional
//      validate(values, toggles) -> null | 'why it is invalid',
//      submit({ values, toggles, targetChannel, interaction, session }) ->
//         Promise<string>   // returns a short confirmation summary
//    }
//
//  Sessions are in-memory and transient: a restart drops them (the stale
//  buttons then answer "session expired"), which is fine for a compose UI.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ChannelSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');

// customId prefix — namespaced so it can't collide with tickets/giveaways/etc.
const NS = 'umbrax_ib';
// Idle timeout: a builder left untouched is disabled and dropped after this.
const SESSION_TTL_MS = 10 * 60 * 1000;

function createInteractiveBuilder({ C, BRAND, FOOTER }) {
    // sessionId -> { id, userId, guildId, originChannelId, values, toggles,
    //               targetChannelId, spec, messageId, timer }
    const sessions = new Map();
    let seq = 0;

    // Compact, collision-resistant enough for concurrent live builders.
    function newSessionId() {
        seq = (seq + 1) % 1e6;
        return seq.toString(36) + '_' + Date.now().toString(36).slice(-5);
    }

    // Split a spec's fields into modal-sized groups (≤5 inputs each). Honour an
    // explicit `groups` layout when the spec provides one.
    function groupsOf(spec) {
        if (spec.groups && spec.groups.length) {
            return spec.groups.map(g => ({
                label: g.label,
                fields: g.keys.map(k => spec.fields.find(f => f.key === k)).filter(Boolean),
            })).filter(g => g.fields.length);
        }
        const out = [];
        for (let i = 0; i < spec.fields.length; i += 5) {
            out.push({ label: `Edit ${out.length + 1}`, fields: spec.fields.slice(i, i + 5) });
        }
        return out;
    }

    // ── open a builder in response to a prefix command ───────────────
    async function start(message, spec) {
        const id = newSessionId();
        const values = {};
        for (const f of spec.fields) if (f.initial != null) values[f.key] = String(f.initial);
        const toggles = {};
        for (const t of (spec.toggles || [])) toggles[t.key] = !!t.initial;

        const session = {
            id,
            userId: message.author.id,
            guildId: message.guild?.id || null,
            originChannelId: message.channel.id,
            values,
            toggles,
            targetChannelId: message.channel.id,
            spec,
            messageId: null,
            timer: null,
        };
        sessions.set(id, session);
        armExpiry(session);

        const sent = await message.channel.send(renderPanel(session));
        session.messageId = sent.id;
        await message.delete().catch(() => {});
        return sent;
    }

    // ── build the whole message (preview + control panel) ────────────
    function renderPanel(session) {
        const { spec } = session;
        const ctx = { session, guild: session.guild };
        const preview = spec.buildPreview(session.values, session.toggles, ctx);
        const content = spec.previewContent ? spec.previewContent(session.values, session.toggles, ctx) : undefined;

        const info = new EmbedBuilder()
            .setColor(spec.accent || C.main)
            .setAuthor({ name: BRAND })
            .setTitle(`\`🛠️\` ${spec.title}`)
            .setDescription([
                'Fill in the fields below — the preview updates live.',
                'Press **Post** when it looks right, or **Cancel** to discard.',
            ].join('\n'))
            .setFooter(FOOTER);

        return {
            content: content || undefined,
            embeds: [info, preview],
            components: controlRows(session),
            allowedMentions: { parse: [] },   // never ping from the preview
        };
    }

    function controlRows(session) {
        const { spec, id } = session;
        const groups = groupsOf(spec);
        const rows = [];

        // Field editing: a select menu when there are multiple groups, else a
        // single Edit button folded into the action row below.
        if (groups.length > 1) {
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`${NS}:${id}:pick`)
                .setPlaceholder('✏️ Edit fields…')
                .addOptions(groups.map((g, i) => ({
                    label: g.label.slice(0, 100),
                    value: String(i),
                    description: g.fields.map(f => f.label).join(', ').slice(0, 100),
                })));
            rows.push(new ActionRowBuilder().addComponents(menu));
        }

        // Native channel picker for "where does this post".
        if (spec.channelTarget) {
            const chan = new ChannelSelectMenuBuilder()
                .setCustomId(`${NS}:${id}:chan`)
                .setPlaceholder('📤 Post to… (default: here)')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setMinValues(1).setMaxValues(1);
            rows.push(new ActionRowBuilder().addComponents(chan));
        }

        // Toggle buttons (timestamp, ping, …).
        if (spec.toggles && spec.toggles.length) {
            const row = new ActionRowBuilder();
            for (const t of spec.toggles.slice(0, 5)) {
                const on = !!session.toggles[t.key];
                row.addComponents(new ButtonBuilder()
                    .setCustomId(`${NS}:${id}:tog:${t.key}`)
                    .setLabel(on ? (t.onText || `${t.label}: On`) : (t.offText || `${t.label}: Off`))
                    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary));
            }
            rows.push(row);
        }

        // Final action row: (optional single Edit button) + Post / Reset / Cancel.
        const actions = new ActionRowBuilder();
        if (groups.length === 1) {
            actions.addComponents(new ButtonBuilder()
                .setCustomId(`${NS}:${id}:pick0`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary));
        }
        actions.addComponents(
            new ButtonBuilder().setCustomId(`${NS}:${id}:post`).setLabel('Post').setEmoji('📨').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`${NS}:${id}:reset`).setLabel('Reset').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`${NS}:${id}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
        );
        rows.push(actions);
        return rows;
    }

    // ── interaction routing ──────────────────────────────────────────
    async function handleInteraction(interaction) {
        const cid = interaction.customId;
        if (typeof cid !== 'string' || !cid.startsWith(NS + ':')) return false;

        const [, id, action, ...rest] = cid.split(':');
        const session = sessions.get(id);

        // Session gone (restart / expired / already finished).
        if (!session) {
            await respondExpired(interaction);
            return true;
        }
        // Only the person who opened the builder may drive it.
        if (interaction.user.id !== session.userId) {
            await interaction.reply({ content: 'This builder isn\'t yours — run the command yourself to open one.', ephemeral: true }).catch(() => {});
            return true;
        }
        armExpiry(session);   // any activity refreshes the idle timer

        try {
            if (action === 'pick')   { await openEditModal(interaction, session, Number(interaction.values?.[0] || 0)); return true; }
            if (action === 'pick0')  { await openEditModal(interaction, session, 0); return true; }
            if (action === 'm')      { await onModalSubmit(interaction, session, Number(rest[0] || 0)); return true; }
            if (action === 'chan')   { await onChannelPick(interaction, session); return true; }
            if (action === 'tog')    { await onToggle(interaction, session, rest[0]); return true; }
            if (action === 'reset')  { await onReset(interaction, session); return true; }
            if (action === 'cancel') { await onCancel(interaction, session); return true; }
            if (action === 'post')   { await onPost(interaction, session); return true; }
        } catch (err) {
            console.error(`[UmbraX] builder(${session.spec.kind}) ${action} failed:`, err);
            if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
                interaction.reply({ content: 'Something went wrong with the builder.', ephemeral: true }).catch(() => {});
            }
            return true;
        }
        return true;
    }

    // Open the modal for a field group, prefilled with the current values.
    async function openEditModal(interaction, session, groupIdx) {
        const groups = groupsOf(session.spec);
        const group = groups[groupIdx] || groups[0];
        if (!group) return interaction.reply({ content: 'Nothing to edit.', ephemeral: true }).catch(() => {});

        const modal = new ModalBuilder()
            .setCustomId(`${NS}:${session.id}:m:${groupIdx}`)
            .setTitle(`${session.spec.title} — ${group.label}`.slice(0, 45));

        for (const f of group.fields.slice(0, 5)) {
            const input = new TextInputBuilder()
                .setCustomId(f.key)
                .setLabel(f.label.slice(0, 45))
                .setStyle(f.kind === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                .setRequired(false)   // enforced at Post via spec.validate, not per-field
                .setMaxLength(Math.min(f.max || 1000, 4000));
            if (f.placeholder) input.setPlaceholder(f.placeholder.slice(0, 100));
            const cur = session.values[f.key];
            if (cur != null && cur !== '') input.setValue(String(cur).slice(0, Math.min(f.max || 1000, 4000)));
            modal.addComponents(new ActionRowBuilder().addComponents(input));
        }
        await interaction.showModal(modal).catch(() => {});
    }

    // Modal submitted → store values, re-render the live preview.
    async function onModalSubmit(interaction, session, groupIdx) {
        const groups = groupsOf(session.spec);
        const group = groups[groupIdx] || groups[0];
        for (const f of (group ? group.fields : [])) {
            let v = interaction.fields.getTextInputValue(f.key);
            if (typeof v === 'string') {
                v = v.replace(/\\n/g, '\n');   // let staff type literal \n
                if (v.trim() === '') delete session.values[f.key];
                else session.values[f.key] = v;
            }
        }
        await interaction.update(renderPanel(session)).catch(() => {});
    }

    async function onChannelPick(interaction, session) {
        const chId = interaction.values?.[0];
        if (chId) session.targetChannelId = chId;
        await interaction.update(renderPanel(session)).catch(() => {});
    }

    async function onToggle(interaction, session, key) {
        session.toggles[key] = !session.toggles[key];
        await interaction.update(renderPanel(session)).catch(() => {});
    }

    async function onReset(interaction, session) {
        session.values = {};
        for (const f of session.spec.fields) if (f.initial != null) session.values[f.key] = String(f.initial);
        session.toggles = {};
        for (const t of (session.spec.toggles || [])) session.toggles[t.key] = !!t.initial;
        session.targetChannelId = session.originChannelId;
        await interaction.update(renderPanel(session)).catch(() => {});
    }

    async function onCancel(interaction, session) {
        drop(session);
        await interaction.update({
            content: undefined,
            embeds: [new EmbedBuilder().setColor(C.warn).setTitle('`✖️` Builder Cancelled').setDescription('Nothing was posted.').setFooter(FOOTER)],
            components: [],
        }).catch(() => {});
        setTimeout(() => interaction.message?.delete?.().catch(() => {}), 5000);
    }

    async function onPost(interaction, session) {
        const { spec } = session;

        // Resolve the target channel (must still be sendable).
        let targetChannel = interaction.channel;
        if (spec.channelTarget && session.targetChannelId) {
            const ch = interaction.guild?.channels?.cache?.get(session.targetChannelId)
                || await interaction.guild?.channels?.fetch(session.targetChannelId).catch(() => null);
            if (ch && typeof ch.send === 'function') targetChannel = ch;
        }

        const why = spec.validate ? spec.validate(session.values, session.toggles) : null;
        if (why) {
            return interaction.reply({ content: `⚠ ${why}`, ephemeral: true }).catch(() => {});
        }

        await interaction.deferUpdate().catch(() => {});
        let summary;
        try {
            summary = await spec.submit({
                values: session.values,
                toggles: session.toggles,
                targetChannel,
                interaction,
                session,
            });
        } catch (err) {
            console.error(`[UmbraX] builder(${spec.kind}) submit failed:`, err);
            return interaction.editReply({
                content: undefined,
                embeds: [new EmbedBuilder().setColor(C.error).setTitle('`❌` Couldn\'t Post').setDescription(err.message || 'Unknown error.').setFooter(FOOTER)],
                components: [],
            }).catch(() => {});
        }

        drop(session);
        await interaction.editReply({
            content: undefined,
            embeds: [new EmbedBuilder().setColor(C.success).setTitle('`✅` Posted').setDescription(summary || 'Done.').setFooter(FOOTER)],
            components: [],
        }).catch(() => {});
        setTimeout(() => interaction.message?.delete?.().catch(() => {}), 6000);
    }

    async function respondExpired(interaction) {
        const msg = { content: 'This builder session expired — run the command again to open a fresh one.', ephemeral: true };
        if (interaction.isModalSubmit?.()) return interaction.reply(msg).catch(() => {});
        // Also strip the dead controls off the old message so it can't be reused.
        if (interaction.isMessageComponent?.()) {
            await interaction.update({ components: [] }).catch(() => interaction.reply(msg).catch(() => {}));
            return;
        }
        return interaction.reply?.(msg).catch(() => {});
    }

    // ── session bookkeeping ──────────────────────────────────────────
    function armExpiry(session) {
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => sessions.delete(session.id), SESSION_TTL_MS);
        if (session.timer.unref) session.timer.unref();
    }
    function drop(session) {
        if (session.timer) clearTimeout(session.timer);
        sessions.delete(session.id);
    }

    return { start, handleInteraction };
}

module.exports = createInteractiveBuilder;
