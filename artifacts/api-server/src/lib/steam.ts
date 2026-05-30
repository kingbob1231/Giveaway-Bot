import axios from "axios";
import { logger } from "./logger";

function getSteamApiKey(): string {
  const key = process.env.STEAM_API_KEY;
  if (!key) throw new Error("STEAM_API_KEY environment variable is required");
  return key;
}

export async function resolveSteamId(profileUrl: string): Promise<string | null> {
  const url = profileUrl.trim().replace(/\/$/, "");

  // Direct 64-bit Steam ID profile
  const idMatch = url.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (idMatch) return idMatch[1];

  // Vanity URL (/id/username)
  const vanityMatch = url.match(/steamcommunity\.com\/id\/([^/?#]+)/);
  if (vanityMatch) {
    const vanity = vanityMatch[1];
    try {
      const res = await axios.get(
        "https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/",
        { params: { key: getSteamApiKey(), vanityurl: vanity } },
      );
      if (res.data?.response?.success === 1) {
        return res.data.response.steamid as string;
      }
    } catch (err) {
      logger.warn({ err, vanity }, "Failed to resolve Steam vanity URL");
    }
    return null;
  }

  return null;
}

export interface SteamActivityResult {
  played: boolean;
  gameCount: number;
  profilePrivate: boolean;
  reason: string;
}

/**
 * Checks if a Steam user has played any game within the last 30 days.
 *
 * Strategy:
 * 1. GetRecentlyPlayedGames (last 2 weeks, public API) — fastest signal
 * 2. GetOwnedGames with rtime_last_played — covers the full 30-day window
 *    (rtime_last_played is a Unix timestamp updated on every session)
 *
 * If game details are private, we detect that and report it clearly.
 */
export async function hasPlayedGameInLastMonth(
  steamId: string,
): Promise<SteamActivityResult> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

  // --- Step 1: recently played (last 2 weeks) ---
  try {
    const recentRes = await axios.get(
      "https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/",
      { params: { key: getSteamApiKey(), steamid: steamId, count: 0 } },
    );
    const recentGames: Array<{ appid: number; name: string; playtime_2weeks: number }> =
      recentRes.data?.response?.games ?? [];

    if (recentGames.length > 0) {
      return {
        played: true,
        gameCount: recentGames.length,
        profilePrivate: false,
        reason: `Played ${recentGames.length} game(s) in the last 2 weeks`,
      };
    }
  } catch (err) {
    logger.warn({ err, steamId }, "GetRecentlyPlayedGames failed, falling back");
  }

  // --- Step 2: owned games with rtime_last_played (covers full 30 days) ---
  try {
    const ownedRes = await axios.get(
      "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/",
      {
        params: {
          key: getSteamApiKey(),
          steamid: steamId,
          include_appinfo: 0,
          include_played_free_games: 1,
          // Skip games never played at all to reduce payload
          skip_unvetted_apps: 0,
        },
      },
    );

    const games: Array<{ appid: number; playtime_forever: number; rtime_last_played?: number }> =
      ownedRes.data?.response?.games ?? [];

    // If no games array at all AND game_count is also 0/missing, the profile
    // is likely private or the account has no games.
    const gameCount: number = ownedRes.data?.response?.game_count ?? 0;

    if (gameCount === 0 && games.length === 0) {
      // Could be private or genuinely no games — we can check visibility via
      // GetPlayerSummaries communityvisibilitystate (3 = public, 1/2 = private)
      const visibility = await getProfileVisibility(steamId);
      if (!visibility.isPublic) {
        return {
          played: false,
          gameCount: 0,
          profilePrivate: true,
          reason: "Steam game library is set to private — cannot verify activity",
        };
      }
      return {
        played: false,
        gameCount: 0,
        profilePrivate: false,
        reason: "No games found on this Steam account",
      };
    }

    // Filter games played within the last 30 days using rtime_last_played
    const recentlyPlayed = games.filter(
      (g) => g.rtime_last_played && g.rtime_last_played >= thirtyDaysAgo,
    );

    if (recentlyPlayed.length > 0) {
      return {
        played: true,
        gameCount: recentlyPlayed.length,
        profilePrivate: false,
        reason: `Played ${recentlyPlayed.length} game(s) in the last 30 days`,
      };
    }

    return {
      played: false,
      gameCount: 0,
      profilePrivate: false,
      reason: "No games played in the last 30 days",
    };
  } catch (err) {
    logger.error({ err, steamId }, "GetOwnedGames failed");
    return {
      played: false,
      gameCount: 0,
      profilePrivate: false,
      reason: "Unable to fetch Steam game history — please try again",
    };
  }
}

async function getProfileVisibility(steamId: string): Promise<{ isPublic: boolean }> {
  try {
    const res = await axios.get(
      "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/",
      { params: { key: getSteamApiKey(), steamids: steamId } },
    );
    const player = res.data?.response?.players?.[0];
    // communityvisibilitystate: 1=Private, 2=FriendsOnly, 3=Public
    return { isPublic: player?.communityvisibilitystate === 3 };
  } catch {
    return { isPublic: true }; // assume public on error so we don't wrongly block
  }
}

export async function getSteamProfile(
  steamId: string,
): Promise<{ name: string; avatar: string } | null> {
  try {
    const res = await axios.get(
      "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/",
      { params: { key: getSteamApiKey(), steamids: steamId } },
    );
    const player = res.data?.response?.players?.[0];
    if (!player) return null;
    return { name: player.personaname as string, avatar: player.avatarmedium as string };
  } catch {
    return null;
  }
}
