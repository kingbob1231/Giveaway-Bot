import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";
import { db } from "@workspace/db";
import { giveawaysTable, giveawayEntriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { editInteractionResponse, editMessage, sendMessage, sendInteractionFollowup, dmUser } from "./discordRest";
import { logger } from "./logger";

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID ?? "";
// Interaction webhook tokens are valid for 15 minutes
const WEBHOOK_TOKEN_TTL_MS = 14 * 60 * 1000;

export function buildGiveawayEmbed(
  prize: string,
  endsAt: Date,
  entryCount: number,
  ended: boolean,
  winners: string[] = [],
  giveawayId?: number,
  imageUrl?: string | null,
) {
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x95a5a6 : 0xf1c40f)
    .setTitle(ended ? `🎉 Giveaway Ended — ${prize}` : `🎁 Giveaway — ${prize}`)
    .addFields(
      { name: "Entries", value: String(entryCount), inline: true },
      {
        name: ended ? "Ended" : "Ends",
        value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`,
        inline: true,
      },
    );

  if (imageUrl) embed.setImage(imageUrl);

  const idSuffix = giveawayId !== undefined ? ` • ID: ${giveawayId}` : "";

  if (ended) {
    embed.addFields({
      name: "Winner(s)",
      value: winners.length > 0 ? winners.map((id) => `<@${id}>`).join(", ") : "No valid entries",
    });
    embed.setFooter({ text: `Giveaway ended${idSuffix}` });
  } else {
    embed.setDescription(
      "Click **Enter Giveaway** below to participate!\n" +
        "You will be asked for your Steam profile URL.\n\n" +
        "You must have played a game on Steam in the last 30 days to qualify.",
    );
    embed.setFooter({ text: `Steam activity verified via Steam Web API${idSuffix}` });
  }

  return embed.toJSON();
}

export function buildEnterButtonRow(disabled = false) {
  const btn = new ButtonBuilder()
    .setCustomId("enter_giveaway")
    .setLabel(disabled ? "Giveaway Ended" : "Enter Giveaway")
    .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(disabled);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(btn).toJSON();
}

/**
 * Returns true if the interaction token is still within the 15-minute window.
 */
function isTokenStillValid(giveawayCreatedAt: Date): boolean {
  return Date.now() - giveawayCreatedAt.getTime() < WEBHOOK_TOKEN_TTL_MS;
}

/**
 * Try to edit the original giveaway embed.
 * Prefers the bot-token direct edit (channelId + messageId, no expiry).
 * Falls back to the interaction webhook token if messageId is not yet stored
 * (i.e. within the first few seconds after the giveaway is created).
 */
export async function tryUpdateGiveawayEmbed(
  giveaway: { id: number; prize: string; endsAt: Date; createdAt: Date; channelId: string; interactionToken: string | null; messageId: string | null; imageUrl?: string | null },
  entryCount: number,
  ended: boolean,
  winners: string[] = [],
) {
  const embed = buildGiveawayEmbed(giveaway.prize, giveaway.endsAt, entryCount, ended, winners, giveaway.id, giveaway.imageUrl);
  const row = buildEnterButtonRow(ended);

  if (giveaway.channelId && giveaway.messageId) {
    try {
      await editMessage(giveaway.channelId, giveaway.messageId, {
        embeds: [embed],
        components: [row],
      });
      return;
    } catch (err) {
      logger.warn({ err, giveawayId: giveaway.id }, "Could not update giveaway embed via bot token");
    }
  }

  if (giveaway.interactionToken && isTokenStillValid(giveaway.createdAt)) {
    try {
      await editInteractionResponse(APPLICATION_ID, giveaway.interactionToken, {
        embeds: [embed],
        components: [row],
      });
    } catch (err) {
      logger.warn({ err, giveawayId: giveaway.id }, "Could not update giveaway embed via interaction token");
    }
  }
}

export async function endGiveaway(giveawayId: number) {
  const [giveaway] = await db
    .select()
    .from(giveawaysTable)
    .where(eq(giveawaysTable.id, giveawayId));

  if (!giveaway || giveaway.ended) return;

  const entries = await db
    .select()
    .from(giveawayEntriesTable)
    .where(eq(giveawayEntriesTable.giveawayId, giveawayId));

  const winners: string[] = [];
  if (entries.length > 0) {
    const shuffled = [...entries].sort(() => Math.random() - 0.5);
    for (let i = 0; i < Math.min(giveaway.winnersCount, entries.length); i++) {
      winners.push(shuffled[i].userId);
    }
  }

  await db
    .update(giveawaysTable)
    .set({ ended: true, winnerUserIds: winners })
    .where(eq(giveawaysTable.id, giveawayId));

  logger.info({ giveawayId, entryCount: entries.length, winners }, "Giveaway ended");

  const announcement =
    winners.length > 0
      ? `🎉 Congratulations ${winners.map((id) => `<@${id}>`).join(", ")}! You won **${giveaway.prize}**!`
      : `The giveaway for **${giveaway.prize}** ended with no valid entries.`;

  const embed = buildGiveawayEmbed(giveaway.prize, giveaway.endsAt, entries.length, true, winners, giveaway.id, giveaway.imageUrl);
  const row = buildEnterButtonRow(true);

  // Prefer direct bot-token edit (works regardless of how long the giveaway ran)
  if (giveaway.channelId && giveaway.messageId) {
    try {
      await editMessage(giveaway.channelId, giveaway.messageId, {
        embeds: [embed],
        components: [row],
      });
    } catch (err) {
      logger.warn({ err, giveawayId }, "Could not update giveaway embed via bot token on end");
    }

    try {
      await sendMessage(giveaway.channelId, { content: announcement });
    } catch (err) {
      logger.warn({ err, giveawayId }, "Could not send winner announcement — trying DM fallback");
      try {
        await dmUser(giveaway.hostUserId, `⏰ Your giveaway **${giveaway.prize}** ended!\n${announcement}`);
      } catch (dmErr) {
        logger.error({ dmErr, giveawayId }, "DM fallback also failed");
      }
    }
    return;
  }

  // Fallback: interaction token (only works within 15 min of giveaway creation)
  if (!giveaway.interactionToken || !isTokenStillValid(giveaway.createdAt)) {
    logger.info({ giveawayId, winners }, "Giveaway ended — no channel/message ID and token expired. Results saved to DB.");
    return;
  }

  try {
    await editInteractionResponse(APPLICATION_ID, giveaway.interactionToken, {
      embeds: [embed],
      components: [row],
    });
  } catch (err) {
    logger.warn({ err, giveawayId }, "Could not update giveaway embed via interaction token on end");
  }

  try {
    await sendInteractionFollowup(APPLICATION_ID, giveaway.interactionToken, { content: announcement });
  } catch (err) {
    logger.warn({ err, giveawayId }, "Could not send winner announcement followup — trying DM fallback");
    try {
      await dmUser(giveaway.hostUserId, `⏰ Your giveaway **${giveaway.prize}** ended!\n${announcement}`);
    } catch (dmErr) {
      logger.error({ dmErr, giveawayId }, "DM fallback also failed");
    }
  }
}
