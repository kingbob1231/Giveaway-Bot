/**
 * Thin helpers for calling the Discord REST API with the bot token.
 * Used for sending/editing messages in channels (e.g. giveaway end announcements).
 */
import axios from "axios";

const BASE = "https://discord.com/api/v10";

function botHeaders() {
  return {
    Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/** Edit an existing bot message in a channel. */
export async function editMessage(
  channelId: string,
  messageId: string,
  body: object,
): Promise<void> {
  await axios.patch(`${BASE}/channels/${channelId}/messages/${messageId}`, body, {
    headers: botHeaders(),
  });
}

/** Send a new message to a channel. */
export async function sendMessage(channelId: string, body: object): Promise<void> {
  await axios.post(`${BASE}/channels/${channelId}/messages`, body, {
    headers: botHeaders(),
  });
}

/**
 * Edit the original deferred interaction response (follow-up after responding with type 5).
 * Uses the interaction webhook — no bot token header needed, token is in the URL.
 */
export async function editInteractionResponse(
  applicationId: string,
  interactionToken: string,
  body: object,
): Promise<void> {
  await axios.patch(
    `${BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    body,
    { headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Send a follow-up message to an interaction (ephemeral or public).
 */
export async function sendInteractionFollowup(
  applicationId: string,
  interactionToken: string,
  body: object,
): Promise<void> {
  await axios.post(
    `${BASE}/webhooks/${applicationId}/${interactionToken}`,
    body,
    { headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Open a DM channel with a user and send them a message.
 * Used as a fallback when the interaction webhook has expired (> 15 min giveaways).
 */
export async function dmUser(userId: string, content: string): Promise<void> {
  // Create or fetch the DM channel
  const dmRes = await axios.post(
    `${BASE}/users/@me/channels`,
    { recipient_id: userId },
    { headers: botHeaders() },
  );
  const dmChannelId: string = dmRes.data.id;

  await axios.post(
    `${BASE}/channels/${dmChannelId}/messages`,
    { content },
    { headers: botHeaders() },
  );
}
