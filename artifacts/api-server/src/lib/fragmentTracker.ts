/**
 * Tracks recent /fragment result messages and refreshes their TON→USD prices
 * every 3 minutes via a cron job.
 */
import cron from "node-cron";
import { getTonUsdPrice, buildFragmentLines, type FragmentItem, type FragmentType, type FragmentFilter } from "./fragment";
import { editMessage } from "./discordRest";
import { logger } from "./logger";

const FRAGMENT_THUMBNAIL = "https://fragment.com/apple-touch-icon.png";

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

interface TrackedMessage {
  channelId: string;
  messageId: string;
  query: string;
  type: FragmentType;
  filter: FragmentFilter;
  items: FragmentItem[];
  storedAt: number;
}

const TTL_MS = 60 * 60 * 1000;
const tracked = new Map<string, TrackedMessage>();

export function trackFragmentMessage(
  channelId: string,
  messageId: string,
  query: string,
  type: FragmentType,
  filter: FragmentFilter,
  items: FragmentItem[],
) {
  const key = `${channelId}:${messageId}`;
  tracked.set(key, { channelId, messageId, query, type, filter, items, storedAt: Date.now() });
  logger.info({ channelId, messageId, key }, "Tracking fragment message for live price updates");
}

async function refreshAll() {
  const now = Date.now();

  for (const [key, entry] of tracked) {
    if (now - entry.storedAt > TTL_MS) {
      tracked.delete(key);
    }
  }

  if (tracked.size === 0) return;

  const tonUsd = await getTonUsdPrice();
  if (!tonUsd) {
    logger.warn("Could not fetch TON price — skipping fragment refresh");
    return;
  }

  logger.info({ tonUsd, count: tracked.size }, "Refreshing fragment message prices");

  for (const [key, entry] of tracked) {
    try {
      const lines = buildFragmentLines(entry.items, entry.type, entry.filter, tonUsd);
      const filterLabel = (FILTER_LABELS[entry.filter] ?? entry.filter) || "Available";
      const searchUrl = `https://fragment.com/${entry.type === "usernames" ? "" : entry.type}?query=${encodeURIComponent(entry.query)}${entry.filter ? `&filter=${entry.filter}` : ""}`;

      await editMessage(entry.channelId, entry.messageId, {
        embeds: [
          {
            color: 0x0088cc,
            title: `🔍 Fragment — ${TYPE_LABELS[entry.type]}: "${entry.query}" (${filterLabel})`,
            description: lines.join("\n\n"),
            thumbnail: { url: FRAGMENT_THUMBNAIL },
            footer: { text: `Top ${entry.items.length} results • fragment.com • TON = $${tonUsd.toFixed(2)} • updates every 3 min` },
            url: searchUrl,
          },
        ],
      });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 403 || status === 404) {
        logger.info({ key, status }, "Fragment message gone — removing from tracker");
        tracked.delete(key);
      } else {
        logger.warn({ err, key }, "Could not refresh fragment price");
      }
    }
  }
}

export function startFragmentTicker() {
  cron.schedule("*/3 * * * *", () => {
    refreshAll().catch((err) => logger.error({ err }, "Fragment price refresh error"));
  });
  logger.info("Fragment price ticker started (every 3 min)");
}
