import {
  Client,
  GatewayIntentBits,
  Events,
  type Interaction,
} from "discord.js";
import { logger } from "../lib/logger";
import {
  handleGiveawayStart,
  handleGiveawayEnd,
  handleGiveawayList,
  handleEnterButton,
  handleSteamModal,
} from "./commands";
import { db } from "@workspace/db";
import { giveawaysTable } from "@workspace/db";
import { eq, and, gt } from "drizzle-orm";
import { endGiveaway } from "../lib/giveawayManager";

export function startBot() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.error("DISCORD_TOKEN is not set — bot will not start");
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (c) => {
    logger.info({ tag: c.user.tag }, "Discord bot ready");
    await rescheduleActiveGiveaways(client);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName !== "giveaway") return;
        const sub = interaction.options.getSubcommand();
        if (sub === "start") await handleGiveawayStart(interaction, client);
        else if (sub === "end") await handleGiveawayEnd(interaction, client);
        else if (sub === "list") await handleGiveawayList(interaction);
      } else if (interaction.isButton()) {
        if (interaction.customId === "enter_giveaway") {
          await handleEnterButton(interaction);
        }
      } else if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith("steam_modal_")) {
          await handleSteamModal(interaction, client);
        }
      }
    } catch (err) {
      logger.error({ err }, "Unhandled interaction error");
      try {
        const msg = { content: "Something went wrong. Please try again.", flags: 64 };
        if ("replied" in interaction && (interaction as any).replied) {
          await (interaction as any).followUp(msg);
        } else if ("deferred" in interaction && (interaction as any).deferred) {
          await (interaction as any).editReply(msg);
        } else if ("reply" in interaction) {
          await (interaction as any).reply(msg);
        }
      } catch {}
    }
  });

  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to log in to Discord");
  });

  return client;
}

/**
 * On restart, re-schedule setTimeout for any giveaways that are still active.
 * This handles the case where the server restarts while a giveaway is running.
 */
async function rescheduleActiveGiveaways(client: Client) {
  try {
    const now = new Date();
    const active = await db
      .select()
      .from(giveawaysTable)
      .where(and(eq(giveawaysTable.ended, false), gt(giveawaysTable.endsAt, now)));

    for (const giveaway of active) {
      const msUntilEnd = giveaway.endsAt.getTime() - Date.now();
      logger.info(
        { giveawayId: giveaway.id, msUntilEnd },
        "Re-scheduling active giveaway",
      );
      setTimeout(() => {
        endGiveaway(client, giveaway.id).catch((err) =>
          logger.error({ err, giveawayId: giveaway.id }, "Re-scheduled end failed"),
        );
      }, Math.max(msUntilEnd, 1000));
    }

    // Also immediately end any that expired while the server was down
    const expired = await db
      .select()
      .from(giveawaysTable)
      .where(and(eq(giveawaysTable.ended, false)));

    for (const g of expired) {
      if (g.endsAt <= now) {
        logger.info({ giveawayId: g.id }, "Ending expired giveaway from downtime");
        await endGiveaway(client, g.id);
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to reschedule active giveaways");
  }
}
