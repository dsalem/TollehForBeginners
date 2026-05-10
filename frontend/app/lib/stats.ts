/**
 * Win/loss tracking. Backed by the FastAPI backend's SQLite store and
 * mirrored in localStorage so we keep working when the backend is offline.
 *
 * Tracks records per game mode from the local user's perspective:
 *   - VS_COMPUTER: user is always WHITE; WHITE winner = win
 *   - ONLINE_MULTIPLAYER: compare winner to the local player's assigned color
 *   - LOCAL: no "you", just count games played (no W/L attribution)
 *
 * Each match is recorded once via `game_id` dedup (enforced both client-side
 * and server-side via PRIMARY KEY).
 */

export type GameStats = {
  vsComputer: { wins: number; losses: number };
  online: { wins: number; losses: number };
  local: { games: number };
  /** game_ids we've already counted, so we don't double-record on refresh. */
  recorded: string[];
};

const STORAGE_KEY = "tolleh_game_stats_v1";
const CLIENT_ID_KEY = "tolleh_client_id_v1";
const MAX_RECORDED_IDS = 200;

/** Stable per-browser anonymous identifier. Generated once on first visit. */
export function getClientId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem(CLIENT_ID_KEY, fresh);
    return fresh;
  } catch {
    // Private mode / quota — fall back to an in-memory id so this session
    // still works (won't persist across reloads, but stats will sync once).
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

export function defaultStats(): GameStats {
  return {
    vsComputer: { wins: 0, losses: 0 },
    online: { wins: 0, losses: 0 },
    local: { games: 0 },
    recorded: [],
  };
}

export function loadStats(): GameStats {
  if (typeof window === "undefined") return defaultStats();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStats();
    const parsed = JSON.parse(raw) as Partial<GameStats>;
    const base = defaultStats();
    return {
      vsComputer: {
        wins: parsed.vsComputer?.wins ?? base.vsComputer.wins,
        losses: parsed.vsComputer?.losses ?? base.vsComputer.losses,
      },
      online: {
        wins: parsed.online?.wins ?? base.online.wins,
        losses: parsed.online?.losses ?? base.online.losses,
      },
      local: { games: parsed.local?.games ?? base.local.games },
      recorded: Array.isArray(parsed.recorded) ? parsed.recorded.slice(-MAX_RECORDED_IDS) : [],
    };
  } catch {
    return defaultStats();
  }
}

export function saveStats(stats: GameStats): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // localStorage can throw in private browsing or if quota is hit; we'd
    // rather lose the in-memory increment than crash gameplay.
  }
}

export function resetStats(): GameStats {
  const fresh = defaultStats();
  saveStats(fresh);
  return fresh;
}

type RecordOutcomeArgs = {
  stats: GameStats;
  gameId: string;
  mode: "LOCAL" | "VS_COMPUTER" | "ONLINE_MULTIPLAYER";
  winner: "WHITE" | "BLACK";
  /** Local player's color in online games; ignored for other modes. */
  localPlayerColor?: "WHITE" | "BLACK" | null;
};

/** Returns the next stats object with this match recorded (immutable update),
 *  or the same reference if the gameId has already been counted. */
export function recordOutcome(args: RecordOutcomeArgs): GameStats {
  const { stats, gameId, mode, winner, localPlayerColor } = args;
  if (!gameId || stats.recorded.includes(gameId)) {
    return stats;
  }

  const next: GameStats = {
    vsComputer: { ...stats.vsComputer },
    online: { ...stats.online },
    local: { ...stats.local },
    // Cap recorded list so we don't grow unboundedly across hundreds of games.
    recorded: [...stats.recorded, gameId].slice(-MAX_RECORDED_IDS),
  };

  if (mode === "VS_COMPUTER") {
    if (winner === "WHITE") next.vsComputer.wins += 1;
    else next.vsComputer.losses += 1;
  } else if (mode === "ONLINE_MULTIPLAYER" && localPlayerColor) {
    if (winner === localPlayerColor) next.online.wins += 1;
    else next.online.losses += 1;
  } else if (mode === "LOCAL") {
    next.local.games += 1;
  }
  return next;
}
