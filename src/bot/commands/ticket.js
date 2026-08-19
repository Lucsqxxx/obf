// ═══════════════════════════════════════════════════════════════
//  UmbraX — Ticket system
//
//  A lightweight support-ticket flow for the community server:
//
//    .ticket setup   (staff) — post a panel with an "Open Ticket" button.
//    .ticket close   (staff) — close the current ticket channel.
//    .ticket add     @user   — add a member to the current ticket.
//    .ticket remove  @user   — remove a member from the current ticket.
//
//  Clicking "Open Ticket" creates a private, numbered channel that only the
//  opener and the support/staff roles can see. Inside, staff can **Claim**
//  the ticket (so two staff don't answer at once) and anyone permitted can
//  **Close** it. Closing asks for confirmation, posts a text transcript to
//  the configured log channel, then deletes the channel.
//
//  Ticket channels carry a topic marker (`umbrax-ticket:<ownerId> …`) so we
//  recognise them and recover the opener without any external storage; the
//  per-guild ticket number comes from the persistent store.
//
//  All button handling goes through `handleInteraction`, wired to the
//  client's interactionCreate event in index.js.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    PermissionsBitField, ChannelType, AttachmentBuilder,
} = require('discord.js');

const P = PermissionsBitField.Flags;

// Button custom IDs — namespaced so they can't collide with other features.
const ID_OPEN          = 'umbrax_ticket_open';
const ID_CLOSE         = 'umbrax_ticket_close';
const ID_CLAIM         = 'umbrax_ticket_claim';
const ID_CLOSE_CONFIRM = 'umbrax_ticket_close_confirm';
const ID_CLOSE_CANCEL  = 'umbrax_ticket_close_cancel';

// Marker prefix written into a ticket channel's topic so we can (a) recognise
// ticket channels and (b) recover the opener's id without a database.
const TOPIC_TAG = 'umbrax-ticket:';

function createTicketHandlers({ C, BRAND, FOOTER, config, store, hasStaffAccess, errorEmbed, staffAccessDeniedEmbed, builder }) {
    const err = (title, desc) =>
        new EmbedBuilder().setColor(C.error).setTitle(`\`❌\` ${title}`).setDescription(desc).setFooter(FOOTER).setTimestamp();
    const ok = (title, desc, color = C.success) =>
        new EmbedBuilder().setColor(color).setAuthor({ name: BRAND }).setTitle(title).setDescription(desc).setFooter(FOOTER).setTimestamp();

    // Default copy for the ticket panel — shared by the plain `.ticket setup`
    // path and the interactive builder (which pre-fills these as editable).
    const PANEL_DEFAULTS = {
        title: 'Support Tickets',
        description:
            'Need help, want to buy, or have a question?\n' +
            'Click **Open Ticket** below and a private channel will be created for you and the staff team.',
        guidelines: '• One ticket per issue\n• Describe your request clearly\n• Be patient — staff will respond as soon as they can',
        button: 'Open Ticket',
    };

    // Build the panel embed + Open-Ticket row from a (possibly partial) values
    // object, falling back to the defaults for anything left blank.
    function buildPanel(v = {}) {
        const title       = (v.title || '').trim() || PANEL_DEFAULTS.title;
        const description = (v.description || '').trim() || PANEL_DEFAULTS.description;
        const guidelines  = (v.guidelines || '').trim();
        const buttonLabel = (v.button || '').trim() || PANEL_DEFAULTS.button;

        const embed = new EmbedBuilder()
            .setColor(C.main)
            .setAuthor({ name: BRAND })
            .setTitle(`\`🎫\` ${title}`.slice(0, 256))
            .setDescription(description.slice(0, 4096))
            .setFooter(FOOTER)
            .setTimestamp();
        if (guidelines) embed.addFields({ name: 'Guidelines', value: guidelines.slice(0, 1024), inline: false });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(ID_OPEN).setLabel(buttonLabel.slice(0, 80)).setEmoji('🎫').setStyle(ButtonStyle.Primary),
        );
        return { embed, row };
    }

    // ── Interactive builder spec ─────────────────────────────────
    // `.ticket builder` opens a live-preview composer for the panel copy.
    function panelBuilderSpec() {
        return {
            kind: 'ticketpanel',
            title: 'Ticket Panel Builder',
            accent: C.main,
            channelTarget: true,
            fields: [
                { key: 'title',       label: 'Panel Title',    kind: 'short',     max: 200,  placeholder: PANEL_DEFAULTS.title },
                { key: 'description', label: 'Description',     kind: 'paragraph', max: 2000, placeholder: PANEL_DEFAULTS.description },
                { key: 'guidelines',  label: 'Guidelines',     kind: 'paragraph', max: 1024, placeholder: PANEL_DEFAULTS.guidelines },
                { key: 'button',      label: 'Button Label',   kind: 'short',     max: 80,   placeholder: PANEL_DEFAULTS.button },
            ],
            buildPreview(v) { return buildPanel(v).embed; },
            validate() {
                if (!config?.managerRoleId) return null;   // access already gated upstream
                return null;
            },
            async submit({ values, targetChannel }) {
                const me = targetChannel.guild?.members?.me;
                if (me && !me.permissions?.has(P.ManageChannels)) {
                    throw new Error('I need the **Manage Channels** permission to open ticket channels.');
                }
                const { embed, row } = buildPanel(values);
                await targetChannel.send({ embeds: [embed], components: [row] });
                return `Ticket panel posted in ${targetChannel}.`;
            },
        };
    }

    // ── .ticket <setup|close|add|remove> ─────────────────────────
    async function ticket(message, args) {
        if (!message.guild) return message.reply({ embeds: [err('Guild Only', 'Tickets can only be used in a server.')] });

        const sub = (args[0] || '').toLowerCase();
        if (sub === 'setup' || sub === 'panel')  return setupPanel(message);
        if (sub === 'builder' || sub === 'build') return openPanelBuilder(message);
        if (sub === 'close')  return closeCurrent(message);
        if (sub === 'add')    return addMember(message);
        if (sub === 'remove') return removeMember(message);

        return message.reply({
            embeds: [err('Ticket', [
                '`.ticket setup` — post the default ticket panel',
                '`.ticket builder` — compose a custom panel (live preview)',
                '`.ticket close` — close the current ticket',
                '`.ticket add @user` — add a member to this ticket',
                '`.ticket remove @user` — remove a member from this ticket',
            ].join('\n'))],
        });
    }

    // Post the ticket panel with the "Open Ticket" button. Staff only.
    async function setupPanel(message) {
        if (!hasStaffAccess(message, config.managerRoleId)) {
            return message.reply({ embeds: [staffAccessDeniedEmbed(config.managerRoleId)] });
        }
        if (!message.guild.members.me?.permissions?.has(P.ManageChannels)) {
            return message.reply({ embeds: [err('Missing Permission', 'I need the **Manage Channels** permission to open ticket channels.')] });
        }

        const { embed, row } = buildPanel({ guidelines: PANEL_DEFAULTS.guidelines });
        await message.channel.send({ embeds: [embed], components: [row] });
        await message.delete().catch(() => {});
    }

    // Open the interactive live-preview composer for the panel copy. Staff only.
    async function openPanelBuilder(message) {
        if (!hasStaffAccess(message, config.managerRoleId)) {
            return message.reply({ embeds: [staffAccessDeniedEmbed(config.managerRoleId)] });
        }
        if (!message.guild.members.me?.permissions?.has(P.ManageChannels)) {
            return message.reply({ embeds: [err('Missing Permission', 'I need the **Manage Channels** permission to open ticket channels.')] });
        }
        if (!builder) return setupPanel(message);
        return builder.start(message, panelBuilderSpec());
    }

    // Close the ticket the command was run in (asks for confirmation). Opener or staff.
    async function closeCurrent(message) {
        if (!isTicketChannel(message.channel)) {
            return message.reply({ embeds: [err('Not a Ticket', 'Run this inside a ticket channel, or use the **Close Ticket** button.')] });
        }
        const ownerId = ticketOwnerId(message.channel);
        if (message.author.id !== ownerId && !hasStaffAccess(message, config.managerRoleId)) {
            return message.reply({ embeds: [err('Not Allowed', 'Only the ticket opener or staff can close this ticket.')] });
        }
        return promptClose(message.channel, message.author, m => message.reply(m));
    }

    // Add a member to the current ticket. Staff only.
    async function addMember(message) {
        if (!isTicketChannel(message.channel)) return message.reply({ embeds: [err('Not a Ticket', 'Run this inside a ticket channel.')] });
        if (!hasStaffAccess(message, config.managerRoleId)) return message.reply({ embeds: [staffAccessDeniedEmbed(config.managerRoleId)] });
        const target = message.mentions.members?.first();
        if (!target) return message.reply({ embeds: [err('No Member', 'Mention who to add: `.ticket add @user`.')] });
        await message.channel.permissionOverwrites.edit(target.id, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
        }).catch(() => {});
        return message.reply({ embeds: [ok('`➕` Member Added', `${target} was added to this ticket.`, C.info)] });
    }

    // Remove a member from the current ticket. Staff only.
    async function removeMember(message) {
        if (!isTicketChannel(message.channel)) return message.reply({ embeds: [err('Not a Ticket', 'Run this inside a ticket channel.')] });
        if (!hasStaffAccess(message, config.managerRoleId)) return message.reply({ embeds: [staffAccessDeniedEmbed(config.managerRoleId)] });
        const target = message.mentions.members?.first();
        if (!target) return message.reply({ embeds: [err('No Member', 'Mention who to remove: `.ticket remove @user`.')] });
        if (target.id === ticketOwnerId(message.channel)) return message.reply({ embeds: [err('Cannot Remove', 'You can\'t remove the ticket opener. Close the ticket instead.')] });
        await message.channel.permissionOverwrites.delete(target.id).catch(() => {});
        return message.reply({ embeds: [ok('`➖` Member Removed', `${target} was removed from this ticket.`, C.warn)] });
    }

    // ── Interaction (button) routing ─────────────────────────────
    async function handleInteraction(interaction) {
        if (!interaction.isButton?.()) return false;
        switch (interaction.customId) {
            case ID_OPEN:          await openTicket(interaction);   return true;
            case ID_CLAIM:         await claimTicket(interaction);  return true;
            case ID_CLOSE:         await closeViaButton(interaction); return true;
            case ID_CLOSE_CONFIRM: await confirmClose(interaction); return true;
            case ID_CLOSE_CANCEL:  await cancelClose(interaction);  return true;
            default: return false;
        }
    }

    // Create a private, numbered ticket channel for the clicking member.
    async function openTicket(interaction) {
        const guild  = interaction.guild;
        const member = interaction.member;
        if (!guild || !member) return interaction.reply({ content: 'Tickets can only be opened in a server.', ephemeral: true }).catch(() => {});

        const me = guild.members.me;
        if (!me?.permissions?.has(P.ManageChannels)) {
            return interaction.reply({ content: 'I need the **Manage Channels** permission to open tickets.', ephemeral: true }).catch(() => {});
        }

        // One open ticket per member: scan existing channels for their tag.
        const existing = guild.channels.cache.find(
            c => c.type === ChannelType.GuildText && c.topic?.startsWith(TOPIC_TAG + member.id),
        );
        if (existing) {
            return interaction.reply({ content: `You already have an open ticket: ${existing}.`, ephemeral: true }).catch(() => {});
        }

        // Defer early — channel creation can take a moment.
        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        // Permission overwrites: hide from @everyone, allow the opener, the bot,
        // and the support role (if configured).
        const overwrites = [
            { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
            { id: member.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
            { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
        ];
        if (config.supportRoleId && guild.roles.cache.has(config.supportRoleId)) {
            overwrites.push({ id: config.supportRoleId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] });
        }

        // Numbered channel name: ticket-0001, ticket-0002, … (per guild).
        const number = store.nextTicketNumber(guild.id);
        const padded = String(number).padStart(4, '0');

        let channel;
        try {
            channel = await guild.channels.create({
                name: `ticket-${padded}`,
                type: ChannelType.GuildText,
                parent: config.ticketCategoryId && guild.channels.cache.has(config.ticketCategoryId) ? config.ticketCategoryId : undefined,
                topic: `${TOPIC_TAG}${member.id} • #${padded} • opened by ${member.user.tag}`,
                permissionOverwrites: overwrites,
            });
        } catch (e) {
            return interaction.editReply({ content: `Could not create the ticket channel: ${e.message}` }).catch(() => {});
        }

        const welcome = new EmbedBuilder()
            .setColor(C.main)
            .setAuthor({ name: BRAND })
            .setTitle(`\`🎫\` Ticket #${padded}`)
            .setDescription(
                `Hey ${member}, thanks for reaching out.\n` +
                'Describe your issue or request and the staff team will be with you shortly.\n\n' +
                'A staff member can **Claim** this ticket. Press **Close Ticket** when you\'re done.',
            )
            .setFooter(FOOTER)
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(ID_CLAIM).setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(ID_CLOSE).setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
        );

        const ping = config.supportRoleId ? `${member} <@&${config.supportRoleId}>` : `${member}`;
        await channel.send({
            content: ping,
            embeds: [welcome],
            components: [row],
            allowedMentions: { users: [member.id], roles: config.supportRoleId ? [config.supportRoleId] : [] },
        }).catch(() => {});

        await interaction.editReply({ content: `Your ticket has been created: ${channel}.` }).catch(() => {});
    }

    // Staff claims a ticket so it's clear who's handling it.
    async function claimTicket(interaction) {
        if (!isTicketChannel(interaction.channel)) {
            return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true }).catch(() => {});
        }
        if (!hasStaffAccess(interaction, config.managerRoleId)) {
            return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true }).catch(() => {});
        }
        // Rename to mark the claim and announce it; ignore rename failures.
        await interaction.channel.setTopic(`${interaction.channel.topic} • claimed by ${interaction.user.tag}`).catch(() => {});
        await interaction.reply({
            embeds: [ok('`🙋` Ticket Claimed', `${interaction.user} is now handling this ticket.`, C.success)],
        }).catch(() => {});
    }

    // Close a ticket from its in-channel button. Only the opener or staff may.
    async function closeViaButton(interaction) {
        const channel = interaction.channel;
        if (!isTicketChannel(channel)) {
            return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true }).catch(() => {});
        }
        const ownerId = ticketOwnerId(channel);
        const isOwner = interaction.user.id === ownerId;
        const isStaff = hasStaffAccess(interaction, config.managerRoleId);
        if (!isOwner && !isStaff) {
            return interaction.reply({ content: 'Only the ticket opener or staff can close this ticket.', ephemeral: true }).catch(() => {});
        }
        return promptClose(channel, interaction.user, m => interaction.reply({ ...m, ephemeral: false }));
    }

    // Show a confirm/cancel prompt before actually closing.
    async function promptClose(channel, user, reply) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(ID_CLOSE_CONFIRM).setLabel('Confirm Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(ID_CLOSE_CANCEL).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        );
        return reply({
            embeds: [ok('`🔒` Close this ticket?', `${user} requested to close this ticket. Confirm below — a transcript will be saved.`, C.warn)],
            components: [row],
        });
    }

    async function cancelClose(interaction) {
        const isStaff = hasStaffAccess(interaction, config.managerRoleId);
        const isOwner = interaction.user.id === ticketOwnerId(interaction.channel);
        if (!isStaff && !isOwner) return interaction.reply({ content: 'Only the opener or staff can do that.', ephemeral: true }).catch(() => {});
        await interaction.update({
            embeds: [ok('`✅` Close Cancelled', 'This ticket stays open.', C.info)],
            components: [],
        }).catch(() => {});
    }

    // Confirmed close: build a transcript, post it to the log channel, delete.
    async function confirmClose(interaction) {
        const channel = interaction.channel;
        if (!isTicketChannel(channel)) return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true }).catch(() => {});
        const isStaff = hasStaffAccess(interaction, config.managerRoleId);
        const isOwner = interaction.user.id === ticketOwnerId(channel);
        if (!isStaff && !isOwner) return interaction.reply({ content: 'Only the opener or staff can do that.', ephemeral: true }).catch(() => {});

        await interaction.update({
            embeds: [ok('`🔒` Closing Ticket', `Closed by ${interaction.user}. Saving transcript and deleting in a few seconds…`, C.warn)],
            components: [],
        }).catch(() => {});

        await saveTranscript(channel, interaction.user).catch(() => {});
        setTimeout(() => channel.delete().catch(() => {}), 5000);
    }

    // ── Transcript ───────────────────────────────────────────────
    // Fetch up to the last 500 messages and render a plain-text transcript,
    // then post it (as a .txt attachment + summary embed) to the log channel.
    async function saveTranscript(channel, closedBy) {
        if (!config.ticketLogChannelId) return;   // transcripts disabled
        const logChannel = await channel.guild.channels.fetch(config.ticketLogChannelId).catch(() => null);
        if (!logChannel || typeof logChannel.send !== 'function') return;

        const collected = [];
        let before;
        // Page backwards through history (100 at a time, up to 500 messages).
        for (let i = 0; i < 5; i++) {
            const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
            if (!batch || batch.size === 0) break;
            collected.push(...batch.values());
            before = batch.last().id;
            if (batch.size < 100) break;
        }
        collected.reverse();   // oldest first

        const lines = collected.map(m => {
            const stamp = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
            const author = m.author ? `${m.author.tag}` : 'unknown';
            let body = m.content || '';
            if (m.embeds.length) body += (body ? ' ' : '') + `[${m.embeds.length} embed(s)]`;
            if (m.attachments.size) body += (body ? ' ' : '') + [...m.attachments.values()].map(a => `[file: ${a.name}]`).join(' ');
            return `[${stamp}] ${author}: ${body}`;
        });

        const ownerId = ticketOwnerId(channel);
        const header = [
            `Transcript — #${channel.name}`,
            `Guild: ${channel.guild.name} (${channel.guild.id})`,
            `Opener: ${ownerId}`,
            `Closed by: ${closedBy.tag} (${closedBy.id})`,
            `Messages: ${lines.length}`,
            '─'.repeat(48),
            '',
        ].join('\n');

        const content = header + lines.join('\n') + '\n';
        const file = new AttachmentBuilder(Buffer.from(content, 'utf-8'), { name: `${channel.name}-transcript.txt` });

        const summary = new EmbedBuilder()
            .setColor(C.info)
            .setAuthor({ name: BRAND })
            .setTitle('`📄` Ticket Transcript')
            .addFields(
                { name: 'Ticket', value: `#${channel.name}`, inline: true },
                { name: 'Opener', value: ownerId ? `<@${ownerId}>` : 'unknown', inline: true },
                { name: 'Closed by', value: `${closedBy}`, inline: true },
                { name: 'Messages', value: String(lines.length), inline: true },
            )
            .setFooter(FOOTER)
            .setTimestamp();

        await logChannel.send({ embeds: [summary], files: [file] }).catch(() => {});
    }

    // ── Helpers ──────────────────────────────────────────────────
    // A channel is a ticket iff its topic carries our marker tag.
    function isTicketChannel(channel) {
        return channel?.type === ChannelType.GuildText && typeof channel.topic === 'string' && channel.topic.startsWith(TOPIC_TAG);
    }

    // Recover the opener id from the topic marker.
    function ticketOwnerId(channel) {
        if (!isTicketChannel(channel)) return null;
        return channel.topic.slice(TOPIC_TAG.length).split(' ')[0];
    }

    return { ticket, handleInteraction };
}

module.exports = createTicketHandlers;
