"use client";

/**
 * Game-over overlay shown when a player has borne off all 15 checkers.
 * Floats over the board (matches MistakeCard's visual style) so the user
 * sees a clear win/loss result + final pip + match score + per-player
 * performance rating, with a single Continue button to return to the
 * lobby / new-game screen.
 *
 * Match-end (when score reaches matchLength) gets the strongest emphasis
 * via the "match" tag; per-game wins inside an unfinished match show the
 * gentler "game" wording so the user knows there's more to play.
 *
 * Perf section: shows PR (millipoints / move) and a tier name for the
 * local player; in 2-player local / online the OPPONENT'S column appears
 * too so the players can compare. In vs-computer mode only the human's
 * column shows — the computer's PR isn't meaningful (it IS the engine).
 */

import { useState } from "react";
import type { PlayerPerf } from "../lib/perfRating";
import { tierClass } from "../lib/perfRating";

type PlayerColor = "WHITE" | "BLACK";

type Props = {
  winner: PlayerColor;
  localPlayerColor: PlayerColor | null;
  scoreWhite: number;
  scoreBlack: number;
  matchLength: number;
  pipWhite: number;
  pipBlack: number;
  perfWhite: PlayerPerf;
  perfBlack: PlayerPerf;
  /** Hide the opponent's perf column (vs-computer mode). */
  hideOpponentPerf?: boolean;
  onContinue: () => void;
};

export default function GameOverBanner({
  winner,
  localPlayerColor,
  scoreWhite,
  scoreBlack,
  matchLength,
  pipWhite,
  pipBlack,
  perfWhite,
  perfBlack,
  hideOpponentPerf = false,
  onContinue,
}: Props) {
  const youWon = localPlayerColor !== null && winner === localPlayerColor;
  const youLost = localPlayerColor !== null && winner !== localPlayerColor;

  // Single-game vs match-completion. The backend marks `winner` when the
  // match ends, so reaching matchLength means the whole match is over.
  const winnerScore = winner === "WHITE" ? scoreWhite : scoreBlack;
  const matchOver = winnerScore >= matchLength;

  // Loser pip count gives a rough sense of gammon / backgammon.
  const loserPip = winner === "WHITE" ? pipBlack : pipWhite;

  let headline: string;
  if (youWon) headline = matchOver ? "Match Won" : "Game Won";
  else if (youLost) headline = matchOver ? "Match Lost" : "Game Lost";
  else headline = `${winner} Wins`;

  const headlineClass = youWon
    ? "game-over-headline-win"
    : youLost
      ? "game-over-headline-loss"
      : "game-over-headline-neutral";

  // Perf columns: order so the local player is on the left.
  const myColor: PlayerColor = localPlayerColor ?? "WHITE";
  const oppColor: PlayerColor = myColor === "WHITE" ? "BLACK" : "WHITE";
  const myPerf  = myColor  === "WHITE" ? perfWhite : perfBlack;
  const oppPerf = oppColor === "WHITE" ? perfWhite : perfBlack;

  const [showHelp, setShowHelp] = useState(false);

  const renderPerfColumn = (label: string, perf: PlayerPerf) => {
    if (perf.movesAnalyzed === 0) {
      return (
        <div className="perf-column">
          <div className="perf-column-label">{label}</div>
          <div className="perf-column-empty">No analysed moves yet</div>
        </div>
      );
    }
    return (
      <div className="perf-column">
        <div className="perf-column-label">{label}</div>
        <div className={`perf-tier ${tierClass(perf.tier)}`}>{perf.tier}</div>
        <div className="perf-pr">
          <span className="perf-pr-num">{perf.pr.toFixed(1)}</span>
          <span className="perf-pr-unit">PR</span>
        </div>
        <div className="perf-mistakes">
          <div>
            <span className="perf-mistake-lbl">Small</span>
            <span className="perf-mistake-num">{perf.small}</span>
          </div>
          <div>
            <span className="perf-mistake-lbl">Medium</span>
            <span className="perf-mistake-num">{perf.medium}</span>
          </div>
          <div>
            <span className="perf-mistake-lbl">Blunder</span>
            <span className="perf-mistake-num">{perf.blunders}</span>
          </div>
        </div>
        <div className="perf-loss">
          {perf.totalEquityLoss.toFixed(2)} eq lost · {perf.movesAnalyzed} moves
        </div>
      </div>
    );
  };

  return (
    <div className="game-over-banner" role="status" aria-live="polite">
      <div className={`game-over-card ${headlineClass}`}>
        <div className="game-over-headline">{headline}</div>
        <div className="game-over-stats">
          <div className="game-over-stat">
            <span className="game-over-stat-lbl">Match</span>
            <span className="game-over-stat-val">
              {scoreWhite} – {scoreBlack} / {matchLength}
            </span>
          </div>
          <div className="game-over-stat">
            <span className="game-over-stat-lbl">Loser pips left</span>
            <span className="game-over-stat-val">{loserPip}</span>
          </div>
        </div>

        <div className="perf-section">
          <div className="perf-section-head">
            <span className="perf-section-title">Level of play</span>
            <button
              type="button"
              className="perf-help-btn"
              aria-label="How is this calculated?"
              title="How is this calculated?"
              onClick={() => setShowHelp((v) => !v)}
            >
              ?
            </button>
          </div>
          {showHelp ? (
            <div className="perf-help">
              PR = avg millipoints of equity lost per move
              (1000 × Σ loss / # moves), the GNU Backgammon / XG metric.
              Lower is better. Tiers: World Class ≤ 5, Expert 5–8, Advanced
              8–12, Intermediate 12–18, Casual 18–25, Beginner &gt; 25.
            </div>
          ) : null}
          <div className={`perf-grid ${hideOpponentPerf ? "perf-grid-single" : ""}`}>
            {renderPerfColumn(hideOpponentPerf ? "You" : `You (${myColor})`, myPerf)}
            {!hideOpponentPerf
              ? renderPerfColumn(`Opponent (${oppColor})`, oppPerf)
              : null}
          </div>
        </div>

        <button
          type="button"
          className="game-over-continue"
          onClick={onContinue}
        >
          {matchOver ? "Back to lobby" : "Continue"}
        </button>
      </div>
    </div>
  );
}
