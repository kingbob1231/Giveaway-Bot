import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const giveawaysTable = pgTable("giveaways", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id"),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  hostUserId: text("host_user_id").notNull(),
  prize: text("prize").notNull(),
  winnersCount: integer("winners_count").notNull().default(1),
  endsAt: timestamp("ends_at").notNull(),
  ended: boolean("ended").notNull().default(false),
  winnerUserIds: text("winner_user_ids").array(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const giveawayEntriesTable = pgTable("giveaway_entries", {
  id: serial("id").primaryKey(),
  giveawayId: integer("giveaway_id").notNull().references(() => giveawaysTable.id),
  userId: text("user_id").notNull(),
  username: text("username").notNull(),
  steamProfileUrl: text("steam_profile_url").notNull(),
  steamId: text("steam_id").notNull(),
  enteredAt: timestamp("entered_at").notNull().defaultNow(),
});

export const insertGiveawaySchema = createInsertSchema(giveawaysTable).omit({ id: true, createdAt: true });
export const insertEntrySchema = createInsertSchema(giveawayEntriesTable).omit({ id: true, enteredAt: true });

export type Giveaway = typeof giveawaysTable.$inferSelect;
export type GiveawayEntry = typeof giveawayEntriesTable.$inferSelect;
export type InsertGiveaway = z.infer<typeof insertGiveawaySchema>;
export type InsertEntry = z.infer<typeof insertEntrySchema>;
