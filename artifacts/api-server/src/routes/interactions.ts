import { Router } from "express";
import nacl from "tweetnacl";
import { db } from "@workspace/db";
import { giveawaysTable, giveawayEntriesTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { resolveSteamId, hasPlayedGameInLastMonth, getSteamProfile } from "../lib/steam";
import {
  buildGiveawayEmbed,
  buildEnterButtonRow,
  endGiveaway,
  tryUpdateGiveawayEmbed,
} from "../lib/giveawayManager";
import {
  editInteractionResponse,
  sendInteractionFollowup,
} from "../lib/discordRest";
import { logger } from "../lib/logger";
import { searchFragment, type FragmentType, type FragmentFilter } from "../lib/fragment";

const router = Router();

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ?? "";
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID ?? "";

// ─── Signature verification ────────────────────────────────────────────────

function verifyDiscordSignature(
  rawBody: Buffer,
  signature: string,
  timestamp: string,
): boolean {
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody.toString()),
      Buffer.from(signature, "hex"),
      Buffer.from(PUBLIC_KEY, "hex"),
    );
  } catch {
    return false;
  }
}

// ─── Interaction type constants ────────────────────────────────────────────

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, MODAL_SUBMIT: 5 };
const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  MODAL: 9,
};
const MessageFlags = { EPHEMERAL: 64 };

// ─── Helpers ───────────────────────────────────────────────────────────────

function getUser(interaction: any): { id: string; username: string } {
  return interaction.member?.user ?? interaction.user;
}

function getOptionValue(options: any[], name: string): any {
  return options?.find((o: any) => o.name === name)?.value;
}

// Follow up to a deferred interaction with an ephemeral message
async function replyEphemeral(token: string, content: string) {
  await editInteractionResponse(APPLICATION_ID, token, {
    content,
    flags: MessageFlags.EPHEMERAL,
  });
}

// ─── Main route ────────────────────────────────────────────────────────────

router.post("/interactions", (req, res) => {
  // 1. Verify signature
  const signature = req.headers["x-signature-ed25519"] as string;
  const timestamp = req.headers["x-signature-timestamp"] as string;
  const rawBody: Buffer = (req as any).rawBody;

  if (!signature || !timestamp || !rawBody) {
    res.status(401).json({ error: "Missing signature headers" });
    return;
  }

  if (!verifyDiscordSignature(rawBody, signature, timestamp)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const interaction = req.body;

  // 2. PING — Discord sends this to verify the endpoint
  if (interaction.type === InteractionType.PING) {
    res.json({ type: ResponseType.PONG });
    return;
  }

  // 3. Slash commands
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    handleCommand(interaction, res);
    return;
  }

  // 4. Button clicks
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    handleComponent(interaction, res);
    return;
  }

  // 5. Modal submissions
  if (interaction.type === InteractionType.MODAL_SUBMIT) {
    handleModal(interaction, res);
    return;
  }

  res.status(400).json({ error: "Unknown interaction type" });
});

// ─── Slash command router ──────────────────────────────────────────────────

function handleCommand(interaction: any, res: any) {
  const commandName: string = interaction.data?.name ?? "";

  // /fragment — top-level command (no subcommands)
  if (commandName === "fragment") {
    res.json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: MessageFlags.EPHEMERAL } });
    setImmediate(() =>
      handleFragment(interaction, interaction.data?.options ?? []).catch((err) =>
        logger.error({ err }, "handleFragment async error"),
      ),
    );
    return;
  }

  const subcommand = interaction.data?.options?.[0];
  const sub: string = subcommand?.name ?? "";

  if (sub === "start") {
    // Respond with DEFERRED immediately, process async
    res.json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE });
    setImmediate(() =>
      handleGiveawayStart(interaction, subcommand?.options ?? []).catch((err) =>
        logger.error({ err }, "handleGiveawayStart async error"),
      ),
    );
    return;
  }

  if (sub === "end") {
    res.json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: MessageFlags.EPHEMERAL } });
    setImmediate(() =>
      handleGiveawayEnd(interaction, subcommand?.options ?? []).catch((err) =>
        logger.error({ err }, "handleGiveawayEnd async error"),
      ),
    );
    return;
  }

  if (sub === "list") {
    res.json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: MessageFlags.EPHEMERAL } });
    setImmediate(() =>
      handleGiveawayList(interaction).catch((err) =>
        logger.error({ err }, "handleGiveawayList async error"),
      ),
    );
    return;
  }

  if (sub === "result") {
    res.json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: MessageFlags.EPHEMERAL } });
    setImmediate(() =>
      handleGiveawayResult(interaction, subcommand?.options ?? []).catch((err) =>
        logger.error({ err }, "handleGiveawayResult async error"),
      ),
    );
    return;
  }

  if (sub === "entries") {
    res.json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: MessageFlags.EPHEMERAL } });
    setImmediate(() =>
      handleGiveawayEntries(interaction, subcommand?.options ?? []).catch((err) =>
        logger.error({ err }, "handleGiveawayEntries async error"),
      ),
    );
    return;
  }

  res.json({ type: ResponseType.CHANNEL_MESSAGE, data: { content: "Unknown subcommand.", flags: MessageFlags.EPHEMERAL } });
}

// ─── /giveaway start ──────────────────────────────────────────────────────

async function handleGiveawayStart(interaction: any, options: any[]) {
  const token: string = interaction.token;
  const channelId: string = interaction.channel_id ?? interaction.channel?.id;
  const guildId: string | null = interaction.guild_id ?? null;
  const user = getUser(interaction);

  const prize: string = getOptionValue(options, "prize") ?? "Prize";
  const days: number = getOptionValue(options, "days") ?? 0;
  const hours: number = getOptionValue(options, "hours") ?? 0;
  const minutes: number = getOptionValue(options, "minutes") ?? 0;
  const winnersCount: number = getOptionValue(options, "winners") ?? 1;
  const imageUrl: string | null = getOptionValue(options, "image") ?? null;
  const totalMinutes = days * 24 * 60 + hours * 60 + minutes;

  if (totalMinutes <= 0) {
    await replyEphemeral(token, "Please specify a duration using `hours` and/or `minutes` (total must be > 0).");
    return;
  }

  const endsAt = new Date(Date.now() + totalMinutes * 60 * 1000);

  const [giveaway] = await db
    .insert(giveawaysTable)
    .values({ channelId, guildId, hostUserId: user.id, prize, winnersCount, imageUrl, endsAt, interactionToken: token })
    .returning();

  logger.info({ giveawayId: giveaway.id, prize, endsAt }, "Giveaway created — posting embed");

  const embed = buildGiveawayEmbed(prize, endsAt, 0, false, [], giveaway.id, imageUrl);
  const row = buildEnterButtonRow(false);

  // Edit the deferred response to show the giveaway embed
  await editInteractionResponse(APPLICATION_ID, token, {
    embeds: [embed],
    components: [row],
  });

  // Fetch the message ID so we can update it later
  // The interaction original response URL lets us GET the message
  const { default: axios } = await import("axios");
  try {
    const msgRes = await axios.get(
      `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/${token}/messages/@original`,
    );
    const messageId: string = msgRes.data.id;
    await db
      .update(giveawaysTable)
      .set({ messageId })
      .where(eq(giveawaysTable.id, giveaway.id));

    logger.info({ giveawayId: giveaway.id, messageId }, "Giveaway started");
  } catch (err) {
    logger.warn({ err }, "Could not fetch giveaway message ID");
  }

  // Schedule auto-end
  const msUntilEnd = endsAt.getTime() - Date.now();
  setTimeout(() => {
    endGiveaway(giveaway.id).catch((err) =>
      logger.error({ err, giveawayId: giveaway.id }, "Scheduled end failed"),
    );
  }, msUntilEnd);
}

// ─── /giveaway end ────────────────────────────────────────────────────────

async function handleGiveawayEnd(interaction: any, options: any[]) {
  const token: string = interaction.token;
  const user = getUser(interaction);
  const id: number = getOptionValue(options, "id");

  const [giveaway] = await db.select().from(giveawaysTable).where(eq(giveawaysTable.id, id));

  if (!giveaway) {
    await replyEphemeral(token, `No giveaway found with ID **${id}**.`);
    return;
  }
  if (giveaway.ended) {
    await replyEphemeral(token, `Giveaway **${id}** has already ended.`);
    return;
  }
  if (giveaway.hostUserId !== user.id) {
    await replyEphemeral(token, "Only the person who started this giveaway can end it early.");
    return;
  }

  await endGiveaway(id);
  await replyEphemeral(token, `Giveaway **${id}** has been ended.`);
}

// ─── /giveaway list ───────────────────────────────────────────────────────

async function handleGiveawayList(interaction: any) {
  const token: string = interaction.token;
  const channelId: string = interaction.channel_id ?? interaction.channel?.id;

  const active = await db
    .select()
    .from(giveawaysTable)
    .where(and(eq(giveawaysTable.channelId, channelId), eq(giveawaysTable.ended, false)));

  if (active.length === 0) {
    await replyEphemeral(token, "No active giveaways in this channel.");
    return;
  }

  const lines = active.map(
    (g) => `**ID ${g.id}** — ${g.prize}\nEnds <t:${Math.floor(g.endsAt.getTime() / 1000)}:R>`,
  );

  await editInteractionResponse(APPLICATION_ID, token, {
    embeds: [{ color: 0xf1c40f, title: "Active Giveaways", description: lines.join("\n\n") }],
    flags: MessageFlags.EPHEMERAL,
  });
}

// ─── /giveaway result ─────────────────────────────────────────────────────

async function handleGiveawayResult(interaction: any, options: any[]) {
  const token: string = interaction.token;
  const id: number = getOptionValue(options, "id");

  const [giveaway] = await db.select().from(giveawaysTable).where(eq(giveawaysTable.id, id));

  if (!giveaway) {
    await replyEphemeral(token, `No giveaway found with ID **${id}**.`);
    return;
  }

  if (!giveaway.ended) {
    await replyEphemeral(
      token,
      `Giveaway **${id}** (${giveaway.prize}) is still running — ends <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>.`,
    );
    return;
  }

  const winners = giveaway.winnerUserIds ?? [];
  const entries = await db
    .select()
    .from(giveawayEntriesTable)
    .where(eq(giveawayEntriesTable.giveawayId, id));

  const winnerText =
    winners.length > 0
      ? winners.map((uid) => `<@${uid}>`).join(", ")
      : "No valid entries were received.";

  await editInteractionResponse(APPLICATION_ID, token, {
    embeds: [
      {
        color: 0x2ecc71,
        title: `🎉 Giveaway Result — ${giveaway.prize}`,
        fields: [
          { name: "Winner(s)", value: winnerText, inline: false },
          { name: "Total Entries", value: String(entries.length), inline: true },
          {
            name: "Ended",
            value: `<t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:f>`,
            inline: true,
          },
        ],
        footer: { text: `Giveaway ID: ${id} • Hosted by <@${giveaway.hostUserId}>` },
      },
    ],
    flags: MessageFlags.EPHEMERAL,
  });
}

// ─── /giveaway entries ────────────────────────────────────────────────────

async function handleGiveawayEntries(interaction: any, options: any[]) {
  const token: string = interaction.token;
  const id: number = getOptionValue(options, "id");

  const [giveaway] = await db.select().from(giveawaysTable).where(eq(giveawaysTable.id, id));

  if (!giveaway) {
    await replyEphemeral(token, `No giveaway found with ID **${id}**.`);
    return;
  }

  const entries = await db
    .select()
    .from(giveawayEntriesTable)
    .where(eq(giveawayEntriesTable.giveawayId, id));

  if (entries.length === 0) {
    await replyEphemeral(token, `No entries yet for giveaway **${id}** (${giveaway.prize}).`);
    return;
  }

  // Show up to 25 entries — Discord embed field limit
  const shown = entries.slice(0, 25);
  const overflow = entries.length - shown.length;

  const lines = shown.map(
    (e, i) =>
      `**${i + 1}.** <@${e.userId}> — [Steam](https://steamcommunity.com/profiles/${e.steamId}) \`${e.steamId}\``,
  );

  if (overflow > 0) lines.push(`…and **${overflow}** more`);

  await editInteractionResponse(APPLICATION_ID, token, {
    embeds: [
      {
        color: 0x3498db,
        title: `📋 Entries — ${giveaway.prize}`,
        description: lines.join("\n"),
        fields: [
          { name: "Total Entries", value: String(entries.length), inline: true },
          { name: "Status", value: giveaway.ended ? "Ended" : "Active", inline: true },
        ],
        footer: { text: `Giveaway ID: ${id}` },
      },
    ],
    flags: MessageFlags.EPHEMERAL,
  });
}

// ─── Button click (Enter Giveaway) ────────────────────────────────────────

function handleComponent(interaction: any, res: any) {
  if (interaction.data?.custom_id !== "enter_giveaway") {
    res.json({ type: ResponseType.DEFERRED_UPDATE_MESSAGE });
    return;
  }

  const messageId: string = interaction.message?.id;

  // Respond with a MODAL immediately — no DB queries before this
  res.json({
    type: ResponseType.MODAL,
    data: {
      custom_id: `steam_modal_${messageId}`,
      title: "Enter Giveaway — Steam Verification",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "steam_url",
              label: "Your Steam Profile URL",
              style: 1,
              min_length: 20,
              max_length: 120,
              placeholder: "https://steamcommunity.com/id/yourusername",
              required: true,
            },
          ],
        },
      ],
    },
  });
}

// ─── Modal submit (Steam verification) ────────────────────────────────────

function handleModal(interaction: any, res: any) {
  // Respond with DEFERRED immediately so we have time to call Steam API
  res.json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: MessageFlags.EPHEMERAL } });
  setImmediate(() =>
    handleSteamModal(interaction).catch((err) =>
      logger.error({ err }, "handleSteamModal async error"),
    ),
  );
}

async function handleSteamModal(interaction: any) {
  const token: string = interaction.token;
  const user = getUser(interaction);

  const match = interaction.data?.custom_id?.match(/^steam_modal_(.+)$/);
  if (!match) return;
  const messageId = match[1];

  // Helper to update the deferred reply
  const reply = (content: string) => replyEphemeral(token, content);

  // ── 1. Find the giveaway ───────────────────────────────────────────
  const [giveaway] = await db
    .select()
    .from(giveawaysTable)
    .where(and(eq(giveawaysTable.messageId, messageId), eq(giveawaysTable.ended, false)));

  if (!giveaway || giveaway.endsAt <= new Date()) {
    await reply("❌ This giveaway has already ended.");
    return;
  }

  // ── 2. Already entered? ───────────────────────────────────────────
  const [existing] = await db
    .select()
    .from(giveawayEntriesTable)
    .where(
      and(
        eq(giveawayEntriesTable.giveawayId, giveaway.id),
        eq(giveawayEntriesTable.userId, user.id),
      ),
    );

  if (existing) {
    await reply(`You're already entered! Your Steam ID on file: \`${existing.steamId}\``);
    return;
  }

  // ── 3. Get the Steam URL from the modal ───────────────────────────
  const rawUrl: string =
    interaction.data?.components?.[0]?.components?.[0]?.value?.trim() ?? "";

  // ── 4. Resolve Steam ID ───────────────────────────────────────────
  const steamId = await resolveSteamId(rawUrl);
  if (!steamId) {
    await reply(
      "❌ **Invalid Steam URL.** Please use a link like:\n" +
        "`https://steamcommunity.com/id/yourusername`\n" +
        "`https://steamcommunity.com/profiles/76561198xxxxxxxxx`",
    );
    return;
  }

  // ── 5. Check 30-day activity ──────────────────────────────────────
  await editInteractionResponse(APPLICATION_ID, token, {
    content: "🔍 Checking your Steam activity…",
    flags: MessageFlags.EPHEMERAL,
  });

  const activity = await hasPlayedGameInLastMonth(steamId);

  if (activity.profilePrivate) {
    await reply(
      "❌ **Your Steam game library is set to private.**\n" +
        "Please set it to public, then try again:\n" +
        "**Steam → Profile → Edit Profile → Privacy Settings → Game Details → Public**",
    );
    return;
  }

  if (!activity.played) {
    await reply(
      `❌ **You haven't played any games on Steam in the last 30 days.**\n` +
        `You must have at least one gaming session in the past month to qualify.\n\n` +
        `_(${activity.reason})_`,
    );
    return;
  }

  // ── 6. Record entry ───────────────────────────────────────────────
  await db.insert(giveawayEntriesTable).values({
    giveawayId: giveaway.id,
    userId: user.id,
    username: user.username,
    steamProfileUrl: rawUrl,
    steamId,
  });

  // ── 7. Update the giveaway embed with new entry count ─────────────
  const [{ value: totalEntries }] = await db
    .select({ value: count() })
    .from(giveawayEntriesTable)
    .where(eq(giveawayEntriesTable.giveawayId, giveaway.id));

  await tryUpdateGiveawayEmbed(giveaway, totalEntries, false);

  // ── 8. Confirm to user ────────────────────────────────────────────
  const profile = await getSteamProfile(steamId);
  const steamName = profile?.name ?? steamId;

  await reply(
    `✅ **You're in!** Good luck, ${user.username}!\n` +
      `Steam account verified: **${steamName}** (\`${steamId}\`)\n` +
      `_(${activity.reason})_\n\n` +
      `Total entries: **${totalEntries}**`,
  );

  logger.info({ giveawayId: giveaway.id, userId: user.id, steamId }, "New giveaway entry");
}

// ─── /fragment ────────────────────────────────────────────────────────────

const FILTER_LABELS: Record<string, string> = {
  "": "Available",
  auction: "On Auction",
  sale: "For Sale",
  sold: "Sold",
};

const TYPE_LABELS: Record<string, string> = {
  usernames: "Usernames",
  numbers: "Numbers",
  gifts: "Gifts",
};

async function handleFragment(interaction: any, options: any[]) {
  const token: string = interaction.token;
  const query: string = getOptionValue(options, "query") ?? "";
  const type = (getOptionValue(options, "type") ?? "usernames") as FragmentType;
  const filter = (getOptionValue(options, "filter") ?? "") as FragmentFilter;

  try {
    const items = await searchFragment(query, type, filter);

    if (items.length === 0) {
      await replyEphemeral(token, `No results found for **${query}** (${TYPE_LABELS[type]}, ${FILTER_LABELS[filter] ?? filter}).`);
      return;
    }

    const lines = items.map((item) => {
      const price = item.priceTon ? `**${item.priceTon} TON**` : "";
      const extra = item.extra ? ` — ${item.extra}` : "";
      return `[${item.name}](${item.url}) ${price}${extra}`;
    });

    await editInteractionResponse(APPLICATION_ID, token, {
      embeds: [
        {
          color: 0x0088cc,
          title: `🔍 Fragment — ${TYPE_LABELS[type]} "${query}" (${(FILTER_LABELS[filter] ?? filter) || "Available"})`,
          description: lines.join("\n"),
          footer: { text: `Showing top ${items.length} results • fragment.com` },
          url: `https://fragment.com/${type === "usernames" ? "" : type}?query=${encodeURIComponent(query)}${filter ? `&filter=${filter}` : ""}`,
        },
      ],
      flags: MessageFlags.EPHEMERAL,
    });
  } catch (err) {
    logger.error({ err, query, type, filter }, "Fragment search error");
    await replyEphemeral(token, "❌ Failed to fetch Fragment results. The site may be temporarily unavailable.");
  }
}

export default router;
