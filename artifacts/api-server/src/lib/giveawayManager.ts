import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
} from "discord.js";
import { db } from "@workspace/db";
import { giveawaysTable, giveawayEntriesTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
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
    if (winners.length > 0) {
      embed.addFields({
        name: "Winner(s)",
        value: winners.map((id) => `<@${id}>`).join(", "),
      });
    } else {
      embed.addFields({ name: "Winner(s)", value: "No valid entries" });
    }
    embed.setFooter({ text: "This giveaway has ended" });
  } else {
    embed.setDescription(
      "Click **Enter Giveaway** below to participate!\nYou will be asked for your Steam profile URL.\n\nYou must have played a game on Steam in the last 30 days to qualify.",
    );
    embed.setFooter({ text: "Steam activity verified via Steam Web API" });
  }

  return embed;
}

export function buildEnterButton(disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("enter_giveaway")
      .setLabel(disabled ? "Giveaway Ended" : "Enter Giveaway")
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

export async function endGiveaway(client: Client, giveawayId: number) {
  const [giveaway] = await db
    .select()
    .from(giveawaysTable)
    .where(eq(giveawaysTable.id, giveawayId));

  if (!giveaway || giveaway.ended) return;

  const entries = await db
    .select()
    .from(giveawayEntriesTable)
    .where(eq(giveawayEntriesTable.giveawayId, giveawayId));

  const entryCount = entries.length;
  const winners: string[] = [];

  if (entryCount > 0) {
    const shuffled = [...entries].sort(() => Math.random() - 0.5);
    const pickedCount = Math.min(giveaway.winnersCount, entryCount);
    for (let i = 0; i < pickedCount; i++) {
      winners.push(shuffled[i].userId);
    }
  }

  await db
    .update(giveawaysTable)
    .set({ ended: true, winnerUserIds: winners })
    .where(eq(giveawaysTable.id, giveawayId));

  if (!giveaway.messageId) return;

  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    if (!channel || !channel.isTextBased()) return;

    const message = await (channel as any).messages.fetch(giveaway.messageId);
    const embed = buildGiveawayEmbed(giveaway.prize, giveaway.endsAt, entryCount, true, winners);
    const row = buildEnterButton(true);

    await message.edit({ embeds: [embed], components: [row] });

    if (winners.length > 0) {
      await (channel as any).send(
        `🎉 Congratulations ${winners.map((id) => `<@${id}>`).join(", ")}! You won **${giveaway.prize}**!`,
      );
    } else {
      await (channel as any).send(`The giveaway for **${giveaway.prize}** ended with no valid entries.`);
    }
  } catch (err) {
    logger.error({ err, giveawayId }, "Failed to update giveaway message on end");
  }
}
