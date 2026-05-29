import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  MessageFlags,
  EmbedBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { giveawaysTable, giveawayEntriesTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { resolveSteamId, hasPlayedGameInLastMonth, getSteamProfile } from "../lib/steam";
import { buildGiveawayEmbed, buildEnterButton, endGiveaway } from "../lib/giveawayManager";
import { logger } from "../lib/logger";
import type { Client } from "discord.js";

// ─── Slash command definitions ─────────────────────────────────────────────

export const giveawayStartCommand = new SlashCommandBuilder()
  .setName("giveaway")
  .setDescription("Manage giveaways")
  .addSubcommand((sub) =>
    sub
      .setName("start")
      .setDescription("Start a new giveaway")
      .addStringOption((opt) =>
        opt.setName("prize").setDescription("What are you giving away?").setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("hours")
          .setDescription("Duration in hours (combined with minutes)")
          .setMinValue(0)
          .setMaxValue(720),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("minutes")
          .setDescription("Duration in minutes (combined with hours)")
          .setMinValue(0)
          .setMaxValue(59),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("winners")
          .setDescription("Number of winners (default: 1)")
          .setMinValue(1)
          .setMaxValue(10),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("end")
      .setDescription("End an active giveaway early")
      .addIntegerOption((opt) =>
        opt.setName("id").setDescription("Giveaway ID to end").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List active giveaways in this channel"),
  )
  .setIntegrationTypes([0, 1]) // Guild + User install
  .setContexts([0, 1, 2]);    // Guild, BotDM, PrivateChannel (group DMs)

// ─── /giveaway start ──────────────────────────────────────────────────────

export async function handleGiveawayStart(
  interaction: ChatInputCommandInteraction,
  client: Client,
) {
  const prize = interaction.options.getString("prize", true);
  const hours = interaction.options.getInteger("hours") ?? 0;
  const minutes = interaction.options.getInteger("minutes") ?? 0;
  const winnersCount = interaction.options.getInteger("winners") ?? 1;

  const totalMinutes = hours * 60 + minutes;
  if (totalMinutes <= 0) {
    await interaction.reply({
      content: "Please specify a duration using `hours` and/or `minutes` (total must be > 0).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const endsAt = new Date(Date.now() + totalMinutes * 60 * 1000);
  const channelId = interaction.channelId;
  const guildId = interaction.guildId ?? null;

  const [giveaway] = await db
    .insert(giveawaysTable)
    .values({
      channelId,
      guildId,
      hostUserId: interaction.user.id,
      prize,
      winnersCount,
      endsAt,
    })
    .returning();

  const embed = buildGiveawayEmbed(prize, endsAt, 0, false);
  const row = buildEnterButton(false);

  const reply = await interaction.reply({
    embeds: [embed],
    components: [row],
    fetchReply: true,
  });

  // Store the message ID so we can update it later
  await db
    .update(giveawaysTable)
    .set({ messageId: reply.id })
    .where(eq(giveawaysTable.id, giveaway.id));

  // Schedule auto-end
  const msUntilEnd = endsAt.getTime() - Date.now();
  setTimeout(() => {
    endGiveaway(client, giveaway.id).catch((err) =>
      logger.error({ err, giveawayId: giveaway.id }, "Scheduled end failed"),
    );
  }, msUntilEnd);

  logger.info(
    { giveawayId: giveaway.id, prize, endsAt, channelId },
    "Giveaway started",
  );
}

// ─── /giveaway end ────────────────────────────────────────────────────────

export async function handleGiveawayEnd(
  interaction: ChatInputCommandInteraction,
  client: Client,
) {
  const id = interaction.options.getInteger("id", true);

  const [giveaway] = await db
    .select()
    .from(giveawaysTable)
    .where(eq(giveawaysTable.id, id));

  if (!giveaway) {
    await interaction.reply({ content: `No giveaway found with ID **${id}**.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (giveaway.ended) {
    await interaction.reply({ content: `Giveaway **${id}** has already ended.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (giveaway.hostUserId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the person who started this giveaway can end it early.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await endGiveaway(client, id);
  await interaction.editReply({ content: `Giveaway **${id}** has been ended.` });
}

// ─── /giveaway list ───────────────────────────────────────────────────────

export async function handleGiveawayList(interaction: ChatInputCommandInteraction) {
  const active = await db
    .select()
    .from(giveawaysTable)
    .where(
      and(
        eq(giveawaysTable.channelId, interaction.channelId),
        eq(giveawaysTable.ended, false),
      ),
    );

  if (active.length === 0) {
    await interaction.reply({
      content: "No active giveaways in this channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Active Giveaways")
    .setDescription(
      active
        .map(
          (g) =>
            `**ID ${g.id}** — ${g.prize}\nEnds <t:${Math.floor(g.endsAt.getTime() / 1000)}:R>`,
        )
        .join("\n\n"),
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── Enter button click ───────────────────────────────────────────────────

export async function handleEnterButton(interaction: ButtonInteraction) {
  // Find the active giveaway tied to this message
  const [giveaway] = await db
    .select()
    .from(giveawaysTable)
    .where(
      and(
        eq(giveawaysTable.messageId, interaction.message.id),
        eq(giveawaysTable.ended, false),
      ),
    );

  if (!giveaway) {
    await interaction.reply({
      content: "This giveaway has already ended or could not be found.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (giveaway.endsAt <= new Date()) {
    await interaction.reply({
      content: "This giveaway has expired.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if already entered
  const [existing] = await db
    .select()
    .from(giveawayEntriesTable)
    .where(
      and(
        eq(giveawayEntriesTable.giveawayId, giveaway.id),
        eq(giveawayEntriesTable.userId, interaction.user.id),
      ),
    );

  if (existing) {
    await interaction.reply({
      content: `You're already entered in this giveaway! Your Steam ID on file: \`${existing.steamId}\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Show modal for Steam profile URL
  const modal = new ModalBuilder()
    .setCustomId(`steam_modal_${giveaway.id}`)
    .setTitle("Enter Giveaway — Steam Verification");

  const steamInput = new TextInputBuilder()
    .setCustomId("steam_url")
    .setLabel("Your Steam Profile URL")
    .setPlaceholder("https://steamcommunity.com/id/yourusername  or  /profiles/76561198...")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(20)
    .setMaxLength(120);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(steamInput));
  await interaction.showModal(modal);
}

// ─── Modal submit (Steam URL) ──────────────────────────────────────────────

export async function handleSteamModal(interaction: ModalSubmitInteraction, client: Client) {
  const match = interaction.customId.match(/^steam_modal_(\d+)$/);
  if (!match) return;
  const giveawayId = parseInt(match[1], 10);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rawUrl = interaction.fields.getTextInputValue("steam_url").trim();

  // ── 1. Resolve Steam ID ────────────────────────────────────────────
  const steamId = await resolveSteamId(rawUrl);
  if (!steamId) {
    await interaction.editReply({
      content:
        "❌ **Invalid Steam URL.** Please use a link like:\n" +
        "`https://steamcommunity.com/id/yourusername`\n" +
        "`https://steamcommunity.com/profiles/76561198xxxxxxxxx`",
    });
    return;
  }

  // ── 2. Check 30-day activity ───────────────────────────────────────
  await interaction.editReply({ content: "🔍 Checking your Steam activity…" });

  const activity = await hasPlayedGameInLastMonth(steamId);

  if (activity.profilePrivate) {
    await interaction.editReply({
      content:
        "❌ **Your Steam game library is set to private.**\n" +
        "Please make it public so we can verify your activity:\n" +
        "Steam → Profile → Edit Profile → Privacy Settings → Game Details → **Public**\n\n" +
        "Then try entering again.",
    });
    return;
  }

  if (!activity.played) {
    await interaction.editReply({
      content:
        `❌ **You haven't played any games on Steam in the last 30 days.**\n` +
        `To qualify, you must have at least one gaming session in the past month.\n\n` +
        `_(Reason: ${activity.reason})_`,
    });
    return;
  }

  // ── 3. Double-check giveaway still open ───────────────────────────
  const [giveaway] = await db
    .select()
    .from(giveawaysTable)
    .where(eq(giveawaysTable.id, giveawayId));

  if (!giveaway || giveaway.ended || giveaway.endsAt <= new Date()) {
    await interaction.editReply({ content: "❌ This giveaway has already ended." });
    return;
  }

  // ── 4. Check not already entered (race-condition guard) ───────────
  const [alreadyEntered] = await db
    .select()
    .from(giveawayEntriesTable)
    .where(
      and(
        eq(giveawayEntriesTable.giveawayId, giveawayId),
        eq(giveawayEntriesTable.userId, interaction.user.id),
      ),
    );

  if (alreadyEntered) {
    await interaction.editReply({ content: "You're already entered in this giveaway!" });
    return;
  }

  // ── 5. Record entry ───────────────────────────────────────────────
  await db.insert(giveawayEntriesTable).values({
    giveawayId,
    userId: interaction.user.id,
    username: interaction.user.username,
    steamProfileUrl: rawUrl,
    steamId,
  });

  // ── 6. Update the giveaway embed with new entry count ─────────────
  const [{ value: totalEntries }] = await db
    .select({ value: count() })
    .from(giveawayEntriesTable)
    .where(eq(giveawayEntriesTable.giveawayId, giveawayId));

  try {
    if (giveaway.messageId) {
      const channel = await client.channels.fetch(giveaway.channelId);
      if (channel?.isTextBased()) {
        const msg = await (channel as any).messages.fetch(giveaway.messageId);
        const embed = buildGiveawayEmbed(giveaway.prize, giveaway.endsAt, totalEntries, false);
        await msg.edit({ embeds: [embed], components: msg.components });
      }
    }
  } catch (err) {
    logger.warn({ err }, "Could not update giveaway embed entry count");
  }

  // ── 7. Fetch Steam display name for nice confirmation ─────────────
  const profile = await getSteamProfile(steamId);
  const steamName = profile?.name ?? steamId;

  await interaction.editReply({
    content:
      `✅ **You're in!** Good luck, ${interaction.user.username}!\n` +
      `Steam account verified: **${steamName}** (\`${steamId}\`)\n` +
      `_(${activity.reason})_\n\n` +
      `Total entries: **${totalEntries}**`,
  });

  logger.info(
    { giveawayId, userId: interaction.user.id, steamId, reason: activity.reason },
    "New giveaway entry",
  );
}
