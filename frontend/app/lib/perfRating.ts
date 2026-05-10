/**
 * Post-game performance rating, XG / GNU Backgammon style.
 *
 * Computed entirely on the client from `game.move_history` — the backend
 * already runs analysis on each move (we use it for HINT + the mistake
 * card), so equity_loss + classification per move are stored on each
 * `analysis_result` for free. We just aggregate them after game-end.
 *
 * PR (Performance Rating) is millipoints of equity lost per move:
 *
 *     PR = 1000 × (Σ equity_loss) / (number of analysed moves)
 *
 * Tiers follow the conventional XG breakdown.
 */

export type MoveQualityClass = "GOOD" | "INACCURACY" | "ERROR" | "BLUNDER";

type AnalyzedMove = {
  player: "WHITE" | "BLACK";
  classification: MoveQualityClass;
  equity_loss: number;
};

export type PerfTier =
  | "World Class"
  | "Expert"
  | "Advanced"
  | "Intermediate"
  | "Casual"
  | "Beginner";

export type PlayerPerf = {
  movesAnalyzed: number;
  totalEquityLoss: number;
  /** Performance Rating (millipoints / move). 0 = perfect play. */
  pr: number;
  tier: PerfTier;
  small: number;     // INACCURACY count (~0.02 EMG)
  medium: number;    // ERROR count       (~0.08 EMG)
  blunders: number;  // BLUNDER count     (≥0.16 EMG)
};

const EMPTY_PERF: PlayerPerf = {
  movesAnalyzed: 0,
  totalEquityLoss: 0,
  pr: 0,
  tier: "World Class",
  small: 0,
  medium: 0,
  blunders: 0,
};

export function tierForPR(pr: number): PerfTier {
  if (pr <= 5) return "World Class";
  if (pr <= 8) return "Expert";
  if (pr <= 12) return "Advanced";
  if (pr <= 18) return "Intermediate";
  if (pr <= 25) return "Casual";
  return "Beginner";
}

/** Tier → CSS class suffix used by GameOverBanner so the same colour ramp
 *  stays in CSS rather than inlined in JSX. World Class = gold/green,
 *  Beginner = red/grey, with a smooth ramp in between. */
export function tierClass(tier: PerfTier): string {
  switch (tier) {
    case "World Class":  return "perf-tier-world-class";
    case "Expert":       return "perf-tier-expert";
    case "Advanced":     return "perf-tier-advanced";
    case "Intermediate": return "perf-tier-intermediate";
    case "Casual":       return "perf-tier-casual";
    case "Beginner":     return "perf-tier-beginner";
  }
}

export function computePerfFor(
  moves: AnalyzedMove[],
  player: "WHITE" | "BLACK",
): PlayerPerf {
  const mine = moves.filter((m) => m.player === player);
  if (mine.length === 0) return EMPTY_PERF;
  let totalLoss = 0;
  let small = 0;
  let medium = 0;
  let blunders = 0;
  for (const m of mine) {
    totalLoss += Math.max(0, m.equity_loss);
    if (m.classification === "INACCURACY") small += 1;
    else if (m.classification === "ERROR") medium += 1;
    else if (m.classification === "BLUNDER") blunders += 1;
  }
  const pr = (totalLoss / mine.length) * 1000;
  return {
    movesAnalyzed: mine.length,
    totalEquityLoss: totalLoss,
    pr,
    tier: tierForPR(pr),
    small,
    medium,
    blunders,
  };
}

/** Build the perf summary from a backend `move_history` array. Filters out
 *  entries with no analysis (which can happen for forced passes / cube
 *  actions where the engine didn't score the move). */
export function perfFromMoveHistory(
  moveHistory: Array<{
    player: "WHITE" | "BLACK";
    analysis_result: {
      classification: MoveQualityClass;
      equity_loss: number;
    } | null;
  }>,
): { white: PlayerPerf; black: PlayerPerf } {
  const analysed: AnalyzedMove[] = [];
  for (const entry of moveHistory) {
    if (!entry.analysis_result) continue;
    analysed.push({
      player: entry.player,
      classification: entry.analysis_result.classification,
      equity_loss: entry.analysis_result.equity_loss,
    });
  }
  return {
    white: computePerfFor(analysed, "WHITE"),
    black: computePerfFor(analysed, "BLACK"),
  };
}
