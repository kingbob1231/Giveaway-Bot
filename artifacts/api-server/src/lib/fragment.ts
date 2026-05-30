/**
 * Fragment.com scraper — uses Fragment's own internal API (same calls their website makes).
 * Fetches a session hash from the homepage, then calls searchAuctions with it.
 */
import axios from "axios";

const BASE = "https://fragment.com";

export const FRAGMENT_THUMBNAIL = "https://fragment.com/apple-touch-icon.png";

export const FILTER_LABELS: Record<string, string> = {
  "": "All Available",
  auction: "On Auction",
  sale: "For Sale",
  sold: "Sold",
};

export const TYPE_LABELS: Record<string, string> = {
  usernames: "Usernames",
  numbers: "Numbers",
  gifts: "Gifts",
};

export type FragmentFilter = "auction" | "sale" | "sold" | "";
export type FragmentType = "usernames" | "numbers" | "gifts";

export interface FragmentItem {
  name: string;
  url: string;
  priceTon: string | null;
  extra: string | null;
}

interface Session {
  apiPath: string;
  cookie: string;
}

/** Parse Fragment relative time strings like "Ends in 2h 4m" → Unix seconds from now. */
function parseRelativeTimeToUnix(text: string): number | null {
  const lower = text.toLowerCase();
  if (!lower.includes("end") && !lower.includes("left") && !/\d+[dhm]/.test(lower)) return null;

  let seconds = 0;
  const days = lower.match(/(\d+)\s*d/);
  const hours = lower.match(/(\d+)\s*h/);
  const minutes = lower.match(/(\d+)\s*m(?!s)/);

  if (days) seconds += parseInt(days[1]) * 86400;
  if (hours) seconds += parseInt(hours[1]) * 3600;
  if (minutes) seconds += parseInt(minutes[1]) * 60;

  return seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : null;
}

/** Return a formatted status string with emoji, using Discord timestamps where possible. */
function getStatusDisplay(extra: string | null, filter: FragmentFilter): string {
  if (!extra) {
    if (filter === "sold") return "💸 **Sold**";
    if (filter === "auction") return "🔨 **On Auction**";
    if (filter === "sale") return "🏷️ **For Sale**";
    return "✅ **Available**";
  }

  const unix = parseRelativeTimeToUnix(extra);
  if (unix) return `🔨 **Auction ends** <t:${unix}:R> (<t:${unix}:t>)`;

  const lower = extra.toLowerCase();
  if (lower.includes("sold")) return "💸 **Sold**";
  if (lower.includes("sale")) return "🏷️ **For Sale**";
  if (lower.includes("available") || lower.includes("buy now")) return "✅ **Available**";

  return `📋 *${extra}*`;
}

/** Fetch a fresh session hash + cookie from Fragment's homepage. */
async function getSession(): Promise<Session> {
  const res = await axios.get(BASE, {
    headers: { "User-Agent": "Mozilla/5.0" },
    withCredentials: false,
  });
  const html: string = res.data;
  const cookies: string[] = (res.headers["set-cookie"] as string[] | undefined) ?? [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");

  const match = html.match(/"apiUrl":"([^"]+)"/);
  if (!match) throw new Error("Could not find Fragment API URL");
  const apiPath = match[1].replace(/\\/g, "");
  return { apiPath, cookie };
}

/** Parse `<tr class="tm-row-selectable">` rows from the search result HTML. */
function parseItems(html: string): FragmentItem[] {
  const rows = [...html.matchAll(/<tr class="tm-row-selectable">([\s\S]*?)<\/tr>/g)];
  const items: FragmentItem[] = [];

  for (const row of rows) {
    const content = row[1];

    if (content.includes("js-load-more")) continue;

    const urlMatch = content.match(/href="(\/(?:username|number|gift)\/[^"]+)"/);
    const nameMatch = content.match(/class="table-cell-value tm-value">(.*?)<\/div>/);
    if (!urlMatch || !nameMatch) continue;

    const url = BASE + urlMatch[1];
    const name = nameMatch[1].replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").trim();

    const priceMatch = content.match(/icon-before icon-ton[^>]*>([^<]+)<\/div>/);
    const priceTon = priceMatch ? priceMatch[1].trim() : null;

    const tds = [...content.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    let extra: string | null = null;
    if (tds.length >= 3) {
      const thirdTd = tds[2][1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (thirdTd) extra = thirdTd.slice(0, 80);
    }

    items.push({ name, url, priceTon, extra });
  }

  return items;
}

/** Fetch current TON price in USD from CoinGecko. Returns null on failure. */
export async function getTonUsdPrice(): Promise<number | null> {
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd",
      { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } },
    );
    return (res.data as any)?.["the-open-network"]?.usd ?? null;
  } catch {
    return null;
  }
}

/**
 * Build rich description lines for a Fragment embed.
 * Each entry is two lines: name link + price/status detail row.
 */
export function buildFragmentLines(
  items: FragmentItem[],
  type: FragmentType,
  filter: FragmentFilter,
  tonUsd: number | null,
): string[] {
  return items.map((item, i) => {
    const displayName = type === "usernames" ? `@${item.name}` : item.name;
    const nameLink = `**${i + 1}.** [**${displayName}**](${item.url})`;

    let priceStr = "";
    if (item.priceTon) {
      const tonNum = parseFloat(item.priceTon.replace(/[^0-9.]/g, ""));
      if (tonUsd && !isNaN(tonNum)) {
        const usd = (tonNum * tonUsd).toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        });
        priceStr = `💎 \`${item.priceTon} TON\` ≈ **${usd}**`;
      } else {
        priceStr = `💎 \`${item.priceTon} TON\``;
      }
    }

    const status = getStatusDisplay(item.extra, filter);
    const detailParts = priceStr ? `${priceStr}  •  ${status}` : status;

    return `${nameLink}\n┗ ${detailParts}`;
  });
}

/** Build the complete Discord embed object for a Fragment search result. */
export function buildFragmentEmbed(
  items: FragmentItem[],
  type: FragmentType,
  filter: FragmentFilter,
  query: string,
  tonUsd: number | null,
  live = false,
) {
  const lines = buildFragmentLines(items, type, filter, tonUsd);
  const filterLabel = FILTER_LABELS[filter] ?? "All Available";
  const searchUrl = `https://fragment.com/${type === "usernames" ? "" : type}?query=${encodeURIComponent(query)}${filter ? `&filter=${filter}` : ""}`;

  const tonFooter = tonUsd ? `💹 TON = **$${tonUsd.toFixed(2)}**` : "";
  const liveNote = live ? "  •  🔄 Live prices (3 min)" : "";
  const footerParts = [`fragment.com`, filterLabel, tonFooter + liveNote].filter(Boolean);

  return {
    color: 0x0098ea,
    author: { name: "Fragment.com Marketplace", icon_url: FRAGMENT_THUMBNAIL, url: "https://fragment.com" },
    title: `🔍  ${TYPE_LABELS[type]}: "${query}"`,
    description: lines.join("\n\n"),
    thumbnail: { url: FRAGMENT_THUMBNAIL },
    footer: { text: footerParts.join("  •  ") },
    timestamp: new Date().toISOString(),
    url: searchUrl,
  };
}

/** Search Fragment. Returns up to 10 items. */
export async function searchFragment(
  query: string,
  type: FragmentType = "usernames",
  filter: FragmentFilter = "",
): Promise<FragmentItem[]> {
  const { apiPath, cookie } = await getSession();

  const body = new URLSearchParams({
    method: "searchAuctions",
    query,
    type,
    ...(filter ? { filter } : {}),
    sort: "price_desc",
  }).toString();

  const res = await axios.post(BASE + apiPath, body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0",
      Referer: BASE + "/",
      Cookie: cookie,
    },
  });

  if (!res.data.ok) throw new Error(res.data.error ?? "Fragment API error");
  const items = parseItems(res.data.html ?? "");
  return items.slice(0, 10);
}
