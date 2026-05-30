import { SlashCommandBuilder } from "discord.js";

export const giveawayCommand = new SlashCommandBuilder()
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
        opt.setName("days").setDescription("Duration in days").setMinValue(0).setMaxValue(30),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("hours")
          .setDescription("Duration in hours (combined with days/minutes)")
          .setMinValue(0)
          .setMaxValue(23),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("minutes")
          .setDescription("Duration in minutes (combined with days/hours)")
          .setMinValue(0)
          .setMaxValue(59),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("winners")
          .setDescription("Number of winners (default: 1)")
          .setMinValue(1)
          .setMaxValue(10),
      )
      .addStringOption((opt) =>
        opt
          .setName("image")
          .setDescription("URL of an image to display on the giveaway embed")
          .setRequired(false),
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
  .addSubcommand((sub) =>
    sub
      .setName("result")
      .setDescription("Show the winner(s) of a completed giveaway")
      .addIntegerOption((opt) =>
        opt.setName("id").setDescription("Giveaway ID").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("entries")
      .setDescription("List all entries for a giveaway")
      .addIntegerOption((opt) =>
        opt.setName("id").setDescription("Giveaway ID").setRequired(true),
      ),
  )
  .setIntegrationTypes([0, 1])
  .setContexts([0, 1, 2]);
