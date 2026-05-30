/**
 * Fragment.com scraper — uses Fragment's own internal API (same calls their website makes).
 * Fetches a session hash from the homepage, then calls searchAuctions with it.
 */
import axios from "axios";

const BASE = "https://fragment.com";

export type FragmentFilter = "auction" | "sale" | "sold" | "";
export type FragmentType = "usernames" | "numbers" | "gifts";

export interface FragmentItem {
  name: string;
  url: string;
  priceTon: string | null;
  extra: string | null; // "ends in X" or "sold" or status text
}

interface Session {
  apiPath: string;
  cookie: string;
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

    // Skip "show more" rows
    if (content.includes("js-load-more")) continue;

    // Item URL + name
    const urlMatch = content.match(/href="(\/(?:username|number|gift)\/[^"]+)"/);
    const nameMatch = content.match(/class="table-cell-value tm-value">(.*?)<\/div>/);
    if (!urlMatch || !nameMatch) continue;

    const url = BASE + urlMatch[1];
    const name = nameMatch[1].replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").trim();

    // Price in TON (icon-ton class)
    const priceMatch = content.match(/icon-before icon-ton[^>]*>([^<]+)<\/div>/);
    const priceTon = priceMatch ? priceMatch[1].trim() : null;

    // Third column — auction timer or status text
    const tds = [...content.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
    let extra: string | null = null;
    if (tds.length >= 3) {
      const thirdTd = tds[2][1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (thirdTd) extra = thirdTd.slice(0, 60);
    }

    items.push({ name, url, priceTon, extra });
  }

  return items;
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
