// ═══════════════════════════════════════════════════════════════
//  UmbraX — Application system (staff-configurable positions)
//
//  A staff/community server can define any number of application
//  "positions" (Moderator, Developer, Support, …), each with its own
//  set of questions and a role that gets assigned on acceptance:
//
//    .application add            (staff) — create/update a position
//    .application remove <key>   (staff) — delete a position
//    .application list           (staff) — show configured positions
//    .application panel          (staff) — post the apply panel
//
//  `.application add` takes `key: value` lines (like .embed), with a
//  repeatable `question:` line:
//
//    .application add
//    key: mod
//    label: Moderator
//    role: @Moderator
//    question: How old are you?
//    question: Why do you want to be a moderator?
//
//  Members click the position in the panel's select menu, answer the
//  questions in a modal, and the submission is posted to the review
//  channel (config.applicationChannelId) with Accept / Deny buttons.
//  Accepting assigns the position's role and DMs the applicant; denying
//  DMs them the outcome. Positions persist in the store, keyed by guild,
//  so they survive restarts.
//
//  All component handling goes through `handleInteraction`, wired to the
//  client's interactionCreate event in index.js.
//  Made by Lucsqx
// ═══════════════════════════════════════════════════════════════

'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    PermissionsBitField,
} = require('discord.js');

const P = PermissionsBitField.Flags;

// Component custom IDs — namespaced so they can't collide with other features.
// The modal/button IDs carry data after a ':' (position key, applicant id).
const ID_SELECT     = 'umbrax_app_select';
const ID_MODAL      = 'umbrax_app_modal';    // umbrax_app_modal:<key>
const ID_ACCEPT     = 'umbrax_app_accept';   // umbrax_app_accept:<userId>:<key>
const ID_DENY       = 'umbrax_app_deny';     // umbrax_app_deny:<userId>:<key>

// Discord limits we have to respect: a modal holds at most 5 text inputs, a
// text-input label is capped at 45 chars, and a select menu shows up to 25
// options. Positions/questions are validated against these at add-time.
const MAX_QUESTIONS   = 5;
const MAX_POSITIONS   = 25;
const LABEL_MAX       = 45;

function createApplicationHandlers({ C, BRAND, FOOTER, config, store, client, hasStaffAccess, errorEmbed, staffAccessDeniedEmbed }) {
    const err = (title, desc) => errorEmbed(title, desc);
    const ok = (title, desc, color = C.success) =>
        new EmbedBuilder().setColor(color).setAuthor({ name: BRAND }).setTitle(title).setDescription(desc).setFooter(FOOTER).setTimestamp();

    // ── .application <sub> ───────────────────────────────────────
    async function application(message, args) {
        if (!message.guild) return message.reply({ embeds: [err('Guild Only', 'Applications can only be configured in a server.')] });
        if (!hasStaffAccess(message, config.managerRoleId)) {
            return message.reply({ embeds: [staffAccessDeniedEmbed(config.managerRoleId)] });
        }

        const sub = (args[0] || '').toLowerCase();
        switch (sub) {
            case 'add':
            case 'set':    return addPosition(message);
            case 'remove':
            case 'delete': return removePosition(message, args.slice(1));
            case 'list':   return listPositions(message);
            case 'panel':
            case 'setup':  return postPanel(message);
            default:
                return message.reply({ embeds: [err('Applications', [
                    '`.application panel` — post the apply panel',
                    '`.application add` — create/update a position (see below)',
                    '`.application remove <key>` — delete a position',
                    '`.application list` — show configured positions',
                    '',
                    'Add a position with `key: value` lines and repeatable `question:`:',
                    '```',
                    '.application add',
                    'key: mod',
                    'label: Moderator',
                    'role: @Moderator',
                    'question: How old are you?',
                    'question: Why do you want this role?',
                    '```',
                ].join('\n'))] });
        }
    }

    // ── add / set ────────────────────────────────────────────────
    async function addPosition(message) {
        // Everything after "add" is the config block. Parse key: value lines,
        // collecting repeatable `question:` lines in order (like .embed's field:).
        const body = message.content.slice(message.content.toLowerCase().indexOf('add') + 3).trim();
        if (!body) return message.reply({ embeds: [err('Nothing to Add', 'Provide `key:`, `label:`, `role:` and at least one `question:` line.')] });

        let key = null, label = null, roleId = null;
        const questions = [];
        for (const line of body.split('\n')) {
            const m = /^(\w+)\s*:\s*([\s\S]*)$/.exec(line.trim());
            if (!m) continue;
            const k = m[1].toLowerCase();
            const v = m[2].trim();
            if (!v) continue;
            switch (k) {
                case 'key':      key = v.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32); break;
                case 'label':    label = v.slice(0, 80); break;
                case 'role': {
                    // Accept a <@&id> mention or a raw id.
                    const id = (v.match(/\d{5,}/) || [])[0];
                    if (id) roleId = id;
                    break;
                }
                case 'question':
                case 'q':        questions.push(v); break;
                default: break;
            }
        }

        if (!key)   return message.reply({ embeds: [err('Missing key', 'Add a `key:` line — a short id like `mod` or `dev`.')] });
        if (!label) return message.reply({ embeds: [err('Missing label', 'Add a `label:` line — the display name, e.g. `Moderator`.')] });
        if (!roleId) return message.reply({ embeds: [err('Missing role', 'Add a `role:` line — mention the role or paste its id.')] });
        if (!message.guild.roles.cache.has(roleId)) {
            return message.reply({ embeds: [err('Role Not Found', `No role with id \`${roleId}\` in this server.`)] });
        }
        if (!questions.length) return message.reply({ embeds: [err('No Questions', 'Add at least one `question:` line.')] });

        // Enforce Discord's modal limits: at most 5 questions, and labels are
        // truncated to 45 chars in the modal (the full text is kept for the
        // review embed). Warn if we had to trim so staff aren't surprised.
        const trimmedCount = questions.length > MAX_QUESTIONS;
        const kept = questions.slice(0, MAX_QUESTIONS);
        const longQs = kept.filter(q => q.length > LABEL_MAX).length;

        const isNew = !store.getPosition(message.guild.id, key);
        if (isNew && store.listPositions(message.guild.id).length >= MAX_POSITIONS) {
            return message.reply({ embeds: [err('Too Many Positions', `A server can have at most ${MAX_POSITIONS} application positions.`)] });
        }

        store.savePosition(message.guild.id, { key, label, roleId, questions: kept });

        const notes = [];
        if (trimmedCount) notes.push(`⚠ Only the first ${MAX_QUESTIONS} questions were kept (Discord modal limit).`);
        if (longQs) notes.push(`⚠ ${longQs} question(s) exceed ${LABEL_MAX} chars and will be shortened in the form (full text still shows to reviewers).`);

        return message.reply({ embeds: [ok(
            `\`📋\` Position ${isNew ? 'Created' : 'Updated'}`,
            [
                `**${label}** (\`${key}\`) → <@&${roleId}>`,
                `${kept.length} question${kept.length === 1 ? '' : 's'}.`,
                ...(notes.length ? ['', ...notes] : []),
                '',
                'Post the panel with `.application panel`.',
            ].join('\n'),
            C.success,
        )] });
    }

    // ── remove ───────────────────────────────────────────────────
    async function removePosition(message, args) {
        const key = (args[0] || '').toLowerCase();
        if (!key) return message.reply({ embeds: [err('Which Position?', 'Usage: `.application remove <key>`. See `.application list`.')] });
        const removed = store.deletePosition(message.guild.id, key);
        if (!removed) return message.reply({ embeds: [err('Not Found', `No position with key \`${key}\`. See \`.application list\`.`)] });
        return message.reply({ embeds: [ok('`🗑️` Position Removed', `Removed the \`${key}\` position.`, C.warn)] });
    }

    // ── list ─────────────────────────────────────────────────────
    async function listPositions(message) {
        const positions = store.listPositions(message.guild.id);
        if (!positions.length) return message.reply({ embeds: [ok('`📋` Applications', 'No positions configured yet. Add one with `.application add`.', C.info)] });
        const lines = positions.map(p =>
            `• **${p.label}** (\`${p.key}\`) → <@&${p.roleId}> • ${p.questions.length} question${p.questions.length === 1 ? '' : 's'}`);
        return message.reply({ embeds: [ok('`📋` Application Positions', lines.join('\n'), C.info)] });
    }

    // ── panel ────────────────────────────────────────────────────
    async function postPanel(message) {
        const positions = store.listPositions(message.guild.id);
        if (!positions.length) return message.reply({ embeds: [err('No Positions', 'Configure at least one position with `.application add` before posting the panel.')] });
        if (!config.applicationChannelId) {
            return message.reply({ embeds: [err('No Review Channel', 'Set `applicationChannelId` in the config so submissions have somewhere to go, then post the panel.')] });
        }

        const embed = new EmbedBuilder()
            .setColor(C.main)
            .setAuthor({ name: BRAND })
            .setTitle('`📋` Staff Applications')
            .setDescription(
                'Interested in joining the team? Pick a position from the menu below and fill out the short form.\n\n' +
                'Your answers are sent to the staff team for review — you\'ll be notified of the outcome by DM.',
            )
            .addFields({
                name: 'Open Positions',
                value: positions.map(p => `• **${p.label}**`).join('\n'),
                inline: false,
            })
            .setFooter(FOOTER)
            .setTimestamp();

        const menu = new StringSelectMenuBuilder()
            .setCustomId(ID_SELECT)
            .setPlaceholder('Select a position to apply for…')
            .addOptions(positions.map(p => ({
                label: p.label.slice(0, 100),
                value: p.key,
                description: `${p.questions.length} question${p.questions.length === 1 ? '' : 's'}`,
            })));

        await message.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
        await message.delete().catch(() => {});
    }

    // ── Interaction routing (select menu / modal / buttons) ───────
    async function handleInteraction(interaction) {
        if (interaction.isStringSelectMenu?.() && interaction.customId === ID_SELECT) {
            await openApplyModal(interaction);
            return true;
        }
        if (interaction.isModalSubmit?.() && interaction.customId.startsWith(ID_MODAL + ':')) {
            await submitApplication(interaction);
            return true;
        }
        if (interaction.isButton?.()) {
            if (interaction.customId.startsWith(ID_ACCEPT + ':')) { await decide(interaction, true);  return true; }
            if (interaction.customId.startsWith(ID_DENY + ':'))   { await decide(interaction, false); return true; }
        }
        return false;
    }

    // Member selected a position → present the modal with its questions.
    async function openApplyModal(interaction) {
        const key = interaction.values?.[0];
        const pos = store.getPosition(interaction.guild?.id, key);
        if (!pos) {
            return interaction.reply({ content: 'That position is no longer available.', ephemeral: true }).catch(() => {});
        }

        const modal = new ModalBuilder()
            .setCustomId(`${ID_MODAL}:${pos.key}`)
            .setTitle(`Apply — ${pos.label}`.slice(0, 45));

        pos.questions.slice(0, MAX_QUESTIONS).forEach((q, i) => {
            const input = new TextInputBuilder()
                .setCustomId(`q${i}`)
                .setLabel(q.slice(0, LABEL_MAX))
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1000)
                .setRequired(true);
            // If the question was longer than the label allows, surface the full
            // text in the placeholder so the applicant still sees what's asked.
            if (q.length > LABEL_MAX) input.setPlaceholder(q.slice(0, 100));
            modal.addComponents(new ActionRowBuilder().addComponents(input));
        });

        await interaction.showModal(modal).catch(() => {});
    }

    // Applicant submitted the modal → post the submission to the review channel.
    async function submitApplication(interaction) {
        const key = interaction.customId.slice((ID_MODAL + ':').length);
        const pos = store.getPosition(interaction.guild?.id, key);
        if (!pos) {
            return interaction.reply({ content: 'That position is no longer available.', ephemeral: true }).catch(() => {});
        }

        const reviewChannel = config.applicationChannelId
            ? await interaction.guild.channels.fetch(config.applicationChannelId).catch(() => null)
            : null;
        if (!reviewChannel || typeof reviewChannel.send !== 'function') {
            return interaction.reply({
                content: 'Applications aren\'t fully set up yet (no review channel). Please let a staff member know.',
                ephemeral: true,
            }).catch(() => {});
        }

        // Pair each question with its answer, truncating to the embed field cap.
        const fields = pos.questions.slice(0, MAX_QUESTIONS).map((q, i) => ({
            name: q.slice(0, 256),
            value: (interaction.fields.getTextInputValue(`q${i}`) || '—').slice(0, 1024),
            inline: false,
        }));

        const applicant = interaction.user;
        const embed = new EmbedBuilder()
            .setColor(C.info)
            .setAuthor({ name: BRAND })
            .setTitle(`\`📋\` New Application — ${pos.label}`)
            .setDescription(`From ${applicant} (\`${applicant.tag}\` • \`${applicant.id}\`)\nApplying for <@&${pos.roleId}>.`)
            .addFields(fields)
            .setFooter(FOOTER)
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${ID_ACCEPT}:${applicant.id}:${pos.key}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`${ID_DENY}:${applicant.id}:${pos.key}`).setLabel('Deny').setEmoji('✖️').setStyle(ButtonStyle.Danger),
        );

        await reviewChannel.send({ embeds: [embed], components: [row] }).catch(() => {});
        await interaction.reply({
            content: `✅ Your application for **${pos.label}** has been submitted. You'll hear back by DM.`,
            ephemeral: true,
        }).catch(() => {});
    }

    // Staff pressed Accept/Deny on a submission embed.
    async function decide(interaction, accepted) {
        if (!hasStaffAccess(interaction, config.managerRoleId)) {
            return interaction.reply({ content: 'Only staff can review applications.', ephemeral: true }).catch(() => {});
        }
        // customId: umbrax_app_(accept|deny):<userId>:<key>
        const parts = interaction.customId.split(':');
        const applicantId = parts[1];
        const key = parts.slice(2).join(':');
        const pos = store.getPosition(interaction.guild?.id, key);

        await interaction.deferUpdate().catch(() => {});

        const member = await interaction.guild.members.fetch(applicantId).catch(() => null);
        let roleNote = '';
        if (accepted) {
            if (!pos) {
                roleNote = '\n⚠ The position no longer exists, so no role was assigned.';
            } else if (!member) {
                roleNote = '\n⚠ The applicant is no longer in the server, so no role was assigned.';
            } else if (!interaction.guild.members.me?.permissions?.has(P.ManageRoles)) {
                roleNote = '\n⚠ I lack the **Manage Roles** permission, so the role wasn\'t assigned.';
            } else {
                const added = await member.roles.add(pos.roleId, 'Application accepted').then(() => true).catch(() => false);
                roleNote = added
                    ? `\n✅ Assigned <@&${pos.roleId}>.`
                    : `\n⚠ Couldn't assign <@&${pos.roleId}> — check my role is above it in the hierarchy.`;
            }
        }

        // Update the review embed to reflect the decision and disable the buttons.
        const decidedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(accepted ? C.success : C.error)
            .addFields({
                name: accepted ? '`✅` Accepted' : '`✖️` Denied',
                value: `By ${interaction.user} • <t:${Math.floor(interaction.message.createdTimestamp / 1000)}:R>`,
                inline: false,
            });
        await interaction.editReply({ embeds: [decidedEmbed], components: [] }).catch(() => {});

        // DM the applicant the outcome (best-effort — they may have DMs closed).
        const label = pos ? pos.label : 'a position';
        const user = member?.user || await client.users.fetch(applicantId).catch(() => null);
        if (user) {
            const dm = new EmbedBuilder()
                .setColor(accepted ? C.success : C.error)
                .setAuthor({ name: BRAND })
                .setTitle(accepted ? '`✅` Application Accepted' : '`✖️` Application Update')
                .setDescription(
                    accepted
                        ? `Congratulations! Your application for **${label}** in **${interaction.guild.name}** was accepted.`
                        : `Thank you for applying for **${label}** in **${interaction.guild.name}**. Unfortunately your application wasn't successful this time — feel free to apply again in the future.`,
                )
                .setFooter(FOOTER)
                .setTimestamp();
            await user.send({ embeds: [dm] }).catch(() => {});
        }

        // Post a short confirmation in the review channel so the audit trail is clear.
        await interaction.followUp({
            embeds: [ok(
                accepted ? '`✅` Application Accepted' : '`✖️` Application Denied',
                `${interaction.user} ${accepted ? 'accepted' : 'denied'} <@${applicantId}>'s application for **${label}**.${roleNote}`,
                accepted ? C.success : C.warn,
            )],
            ephemeral: true,
        }).catch(() => {});
    }

    return { application, handleInteraction };
}

module.exports = createApplicationHandlers;
