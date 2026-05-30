/**
 * Run once to register slash commands with Discord.
 * Usage: npx tsx src/bot/register.ts
 *
 * This registers the /giveaway command globally as a User Install app
 * so it works in servers, DMs, and group DMs.
 */
import { REST, Routes } from "discord.js";
import { giveawayCommand } from "./commandDefinitions";
import { logger } from "../lib/logger";

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;

if (!token || !applicationId) {
  logger.error("DISCORD_TOKEN and DISCORD_APPLICATION_ID must be set");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

const commands = [giveawayCommand.toJSON()];

(async () => {
  try {
    logger.info(`Registering ${commands.length} application command(s)…`);
    await rest.put(Routes.applicationCommands(applicationId), { body: commands });
    logger.info("Commands registered successfully");
  } catch (err) {
    logger.error({ err }, "Failed to register commands");
    process.exit(1);
  }
})();
