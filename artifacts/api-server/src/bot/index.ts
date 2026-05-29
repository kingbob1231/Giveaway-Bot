/**
 * On server startup, re-schedule any active giveaways that haven't ended yet.
 * No Discord gateway connection needed — all interaction handling is via HTTP.
 */
import { db } from "@workspace/db";
import { giveawaysTable } from "@workspace/db";
import { eq, and, gt, lte } from "drizzle-orm";
import { endGiveaway } from "../lib/giveawayManager";
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
    }

    logger.info(
      { expired: expired.length, rescheduled: active.length },
      "Giveaway scheduler ready",
    );
  } catch (err) {
    logger.error({ err }, "Failed to initialise giveaway scheduler");
  }
}
