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
  .setIntegrationTypes([0, 1])
  .setContexts([0, 1, 2]);

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
    // Validation only — safe to reply directly (no DB needed)
    await interaction.reply({
      content: "Please specify a duration using `hours` and/or `minutes` (total must be > 0).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Acknowledge immediately — Discord requires a response within 3 seconds
  logger.info({ prize, totalMinutes, winnersCount }, "Deferring giveaway start reply");
  await interaction.deferReply();
  logger.info("Deferred — running DB insert");

  const endsAt = new Date(Date.now() + totalMinutes * 60 * 1000);
  const channelId = interaction.channelId;
  const guildId = interaction.guildId ?? null;

  const [giveaway] = await db
    .insert(giveawaysTable)
    .values({ channelId, guildId, hostUserId: interaction.user.id, prize, winnersCount, endsAt })
    .returning();
  logger.info({ giveawayId: giveaway.id }, "DB insert done — sending embed");

  const embed = buildGiveawayEmbed(prize, endsAt, 0, false);
  const row = buildEnterButton(false);

  // editReply gives us back the message so we can store its ID
  const reply = await interaction.editReply({ embeds: [embed], components: [row] });
  logger.info({ messageId: reply.id }, "editReply done — storing message ID");

  await db
    .update(giveawaysTable)
    .set({ messageId: reply.id })
    .where(eq(giveawaysTable.id, giveaway.id));

  const msUntilEnd = endsAt.getTime() - Date.now();
  setTimeout(() => {
    endGiveaway(client, giveaway.id).catch((err) =>
      logger.error({ err, giveawayId: giveaway.id }, "Scheduled end failed"),
    );
  }, msUntilEnd);

  logger.info({ giveawayId: giveaway.id, prize, endsAt, channelId }, "Giveaway started");
}

// ─── /giveaway end ────────────────────────────────────────────────────────

export async function handleGiveawayEnd(
  interaction: ChatInputCommandInteraction,
  client: Client,
) {
  // Defer immediately before any DB work
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const id = interaction.options.getInteger("id", true);

  const [giveaway] = await db
    .select()
    .from(giveawaysTable)
    .where(eq(giveawaysTable.id, id));

  if (!giveaway) {
    await interaction.editReply({ content: `No giveaway found with ID **${id}**.` });
    return;
  }
  if (giveaway.ended) {
    await interaction.editReply({ content: `Giveaway **${id}** has already ended.` });
    return;
  }
  if (giveaway.hostUserId !== interaction.user.id) {
    await interaction.editReply({
      content: "Only the person who started this giveaway can end it early.",
    });
    return;
  }

  await endGiveaway(client, id);
  await interaction.editReply({ content: `Giveaway **${id}** has been ended.` });
}

// ─── /giveaway list ───────────────────────────────────────────────────────

export async function handleGiveawayList(interaction: ChatInputCommandInteraction) {
  // Defer immediately before DB query
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const active = await db
    .select()
    .from(giveawaysTable)
    .where(
      and(eq(giveawaysTable.channelId, interaction.channelId), eq(giveawaysTable.ended, false)),
    );

  if (active.length === 0) {
    await interaction.editReply({ content: "No active giveaways in this channel." });
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

  await interaction.editReply({ embeds: [embed] });
}

// ─── Enter button click ───────────────────────────────────────────────────
// IMPORTANT: Must call showModal() within 3 seconds — do NOT query the DB first.
// All validation is deferred to the modal submit handler which can deferReply().

export async function handleEnterButton(interaction: ButtonInteraction) {
  // Show modal immediately — attach the message ID so the modal handler
  // can look up the giveaway without needing any info up front.
  const modal = new ModalBuilder()
    .setCustomId(`steam_modal_${interaction.message.id}`)
    .setTitle("Enter Giveaway — Steam Verification");

  const steamInput = new TextInputBuilder()
    .setCustomId("steam_url")
    .setLabel("Your Steam Profile URL")
    .setPlaceholder(
      "https://steamcommunity.com/id/yourusername  or  /profiles/76561198...",
    )
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(20)
    .setMaxLength(120);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(steamInput));
  await interaction.showModal(modal);
}

// ─── Modal submit (Steam URL) ──────────────────────────────────────────────

export async function handleSteamModal(interaction: ModalSubmitInteraction, client: Client) {
  // customId is `steam_modal_<messageId>` — look up giveaway by message ID
  const match = interaction.customId.match(/^steam_modal_(.+)$/);
  if (!match) return;
  const messageId = match[1];

  // Defer immediately — Steam API calls can take a moment
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // ── 1. Find the giveaway by message ID ────────────────────────────
  const [giveaway] = await db
    .select()
    .from(giveawaysTable)
    .where(and(eq(giveawaysTable.messageId, messageId), eq(giveawaysTable.ended, false)));

  if (!giveaway) {
    await interaction.editReply({ content: "❌ This giveaway has already ended or could not be found." });
    return;
  }
  if (giveaway.endsAt <= new Date()) {
    await interaction.editReply({ content: "❌ This giveaway has expired." });
    return;
  }

  // ── 2. Check if already entered ───────────────────────────────────
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
    await interaction.editReply({
      content: `You're already entered! Your Steam ID on file: \`${existing.steamId}\``,
    });
    return;
  }

  const rawUrl = interaction.fields.getTextInputValue("steam_url").trim();

  // ── 3. Resolve Steam ID ───────────────────────────────────────────
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

  // ── 4. Check 30-day activity ──────────────────────────────────────
  await interaction.editReply({ content: "🔍 Checking your Steam activity…" });

  const activity = await hasPlayedGameInLastMonth(steamId);

  if (activity.profilePrivate) {
    await interaction.editReply({
      content:
        "❌ **Your Steam game library is set to private.**\n" +
        "Please set it to public, then try again:\n" +
        "**Steam → Profile → Edit Profile → Privacy Settings → Game Details → Public**",
    });
    return;
  }

  if (!activity.played) {
    await interaction.editReply({
      content:
        `❌ **You haven't played any games on Steam in the last 30 days.**\n` +
        `You must have at least one gaming session in the past month to qualify.\n\n` +
        `_(${activity.reason})_`,
    });
    return;
  }

  // ── 5. Record entry ───────────────────────────────────────────────
  await db.insert(giveawayEntriesTable).values({
    giveawayId: giveaway.id,
    userId: interaction.user.id,
    username: interaction.user.username,
    steamProfileUrl: rawUrl,
    steamId,
  });

  // ── 6. Update embed entry count ───────────────────────────────────
  const [{ value: totalEntries }] = await db
    .select({ value: count() })
    .from(giveawayEntriesTable)
    .where(eq(giveawayEntriesTable.giveawayId, giveaway.id));

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

  // ── 7. Confirm entry ──────────────────────────────────────────────
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
    { giveawayId: giveaway.id, userId: interaction.user.id, steamId, reason: activity.reason },
    "New giveaway entry",
  );
}
