import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";
import { db } from "@workspace/db";
import { giveawaysTable, giveawayEntriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { editMessage, sendMessage } from "./discordRest";
import { logger } from "./logger";

export function buildGiveawayEmbed(
  prize: string,
  endsAt: Date,
  entryCount: number,
  ended: boolean,
  winners: string[] = [],
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

  if (ended) {
    embed.addFields({
      name: "Winner(s)",
      value: winners.length > 0 ? winners.map((id) => `<@${id}>`).join(", ") : "No valid entries",
    });
    embed.setFooter({ text: "This giveaway has ended" });
  } else {
    embed.setDescription(
      "Click **Enter Giveaway** below to participate!\n" +
        "You will be asked for your Steam profile URL.\n\n" +
        "You must have played a game on Steam in the last 30 days to qualify.",
    );
    embed.setFooter({ text: "Steam activity verified via Steam Web API" });
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

  if (!giveaway.messageId) return;

  try {
    const embed = buildGiveawayEmbed(giveaway.prize, giveaway.endsAt, entries.length, true, winners);
    const row = buildEnterButtonRow(true);

    await editMessage(giveaway.channelId, giveaway.messageId, {
      embeds: [embed],
      components: [row],
    });

    const announcement =
      winners.length > 0
        ? `🎉 Congratulations ${winners.map((id) => `<@${id}>`).join(", ")}! You won **${giveaway.prize}**!`
        : `The giveaway for **${giveaway.prize}** ended with no valid entries.`;

    await sendMessage(giveaway.channelId, { content: announcement });
  } catch (err) {
    logger.error({ err, giveawayId }, "Failed to update giveaway message on end");
  }
}
