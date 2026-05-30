/**
 * On server startup, re-schedule any active giveaways that haven't ended yet.
 * No Discord gateway connection needed — all interaction handling is via HTTP.
 */
import { db } from "@workspace/db";
import { giveawaysTable, giveawayEntriesTable } from "@workspace/db";
import { eq, and, gt, lte, count } from "drizzle-orm";
import { endGiveaway, tryUpdateGiveawayEmbed } from "../lib/giveawayManager";
import { startFragmentTicker } from "../lib/fragmentTracker";
import { logger } from "../lib/logger";

export async function startBot() {
  try {
    const now = new Date();

    // End any giveaways that expired while the server was down
    const expired = await db
      .select()
      .from(giveawaysTable)
      .where(and(eq(giveawaysTable.ended, false), lte(giveawaysTable.endsAt, now)));

    for (const g of expired) {
      logger.info({ giveawayId: g.id }, "Ending giveaway that expired during downtime");
      await endGiveaway(g.id);
    }

    // Re-schedule giveaways still in the future
    const active = await db
      .select()
      .from(giveawaysTable)
      .where(and(eq(giveawaysTable.ended, false), gt(giveawaysTable.endsAt, now)));

    for (const g of active) {
      const msUntilEnd = g.endsAt.getTime() - Date.now();
      logger.info({ giveawayId: g.id, msUntilEnd }, "Re-scheduling active giveaway");
      setTimeout(() => {
        endGiveaway(g.id).catch((err) =>
          logger.error({ err, giveawayId: g.id }, "Re-scheduled end failed"),
        );
      }, Math.max(msUntilEnd, 1000));

      // Sync the embed entry count in case entries came in while server was down
      try {
        const [{ value: entryCount }] = await db
          .select({ value: count() })
          .from(giveawayEntriesTable)
          .where(eq(giveawayEntriesTable.giveawayId, g.id));
        await tryUpdateGiveawayEmbed(g, entryCount, false);
        logger.info({ giveawayId: g.id, entryCount }, "Synced embed entry count on startup");
      } catch (err) {
        logger.warn({ err, giveawayId: g.id }, "Could not sync embed on startup");
      }
    }

    logger.info(
      { expired: expired.length, rescheduled: active.length },
      "Giveaway scheduler ready",
    );

    startFragmentTicker();
  } catch (err) {
    logger.error({ err }, "Failed to initialise giveaway scheduler");
  }
}
