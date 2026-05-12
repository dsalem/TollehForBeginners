"use client";

/**
 * Inline mistake feedback card.
 *
 * Floats over the board's bottom-right corner (inside .board-shell) the moment
 * a sub-optimal move is committed. Surfaces the four pieces of information the
 * user actually wants right now:
 *   1. How bad was it (severity badge)
 *   2. By how much (equity loss)
 *   3. What was the better play (your-vs-best)
 *   4. How confident the engine is (rollout / opening-book footer)
 *
 * Hidden when classification === "GOOD" — for good moves we show no card and
 * the parent surfaces a small confirmation pip elsewhere.
 *
 * Keyboard: Escape dismisses.
 */

import { useEffect } from "react";

type MoveQualityClass = "GOOD" | "INACCURACY" | "ERROR" | "BLUNDER";

// Minimal feedback shape — matches the live PostMoveAnalysisResponse but only
// declares the fields the card actually touches, so the card stays decoupled
// from the page-level type module.
export type MistakeFeedback = {
  best_move: unknown;
  your_move: unknown;
  best_equity: number;
  your_equity: number;
  equity_loss: number;
  best_win_probability?: number;
  your_win_probability?: number;
  classification: MoveQualityClass;
  ranking_method?: string;
  rollout_used?: boolean;
  rollout_candidates_scored?: number;
  opening_book_applied?: boolean;
  explanation?: {
    best_reasons: string[];
    your_drawbacks: string[];
  } | null;
};

type Props = {
  feedback: MistakeFeedback | null;
  /** Called with the live best_move / your_move objects from the parent. */
  formatMove: (move: unknown) => string;
  onDismiss: () => void;
  /** Optional callback when user requests "replay best" on the board. */
  onReplayBest?: () => void;
  /** Optional callback when user requests to replay their own move on the board. */
  onReplayYour?: () => void;
  /** Optional callback to advance the game to the opponent's turn. */
  onContinue?: () => void;
  /** When true, the parent is showing the best-move arrows on the board. */
  arrowsVisible?: boolean;
  onToggleArrows?: () => void;
};

const tierMeta: Record<
  Exclude<MoveQualityClass, "GOOD">,
  { label: string; cls: string; icon: string }
> = {
  INACCURACY: { label: "Slight slip", cls: "tier-slight", icon: "⚠" },
  ERROR:      { label: "Error",       cls: "tier-error",  icon: "⚠" },
  BLUNDER:    { label: "Blunder",     cls: "tier-blunder",icon: "✖" },
};

function formatEquity(n: number): string {
  if (Number.isNaN(n)) return "—";
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  return `${sign}${Math.abs(n).toFixed(3)}`;
}

function formatLoss(n: number): string {
  return Math.abs(n).toFixed(3);
}

function formatPct(n: number | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

export default function MistakeCard({
  feedback,
  formatMove,
  onDismiss,
  onReplayBest,
  onReplayYour,
  onContinue,
  arrowsVisible = true,
  onToggleArrows,
}: Props) {
  // Esc to dismiss
  useEffect(() => {
    if (!feedback || feedback.classification === "GOOD") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [feedback, onDismiss]);

  if (!feedback || feedback.classification === "GOOD") {
    return null;
  }

  const meta = tierMeta[feedback.classification];

  const footerTags: string[] = [];
  if (feedback.ranking_method) footerTags.push(feedback.ranking_method);
  if (feedback.rollout_used) {
    const n = feedback.rollout_candidates_scored;
    footerTags.push(typeof n === "number" && n > 0 ? `rollout · ${n} trials` : "rollout");
  }
  if (feedback.opening_book_applied) footerTags.push("opening book");

  return (
    <div
      className={`mistake-card ${meta.cls}`}
      role="status"
      aria-live="polite"
      aria-label={`${meta.label}: equity lost ${formatLoss(feedback.equity_loss)}`}
    >
      <div className="mistake-card-head">
        <span className="mistake-card-badge">
          <span className="mistake-card-icon" aria-hidden>{meta.icon}</span>
          {meta.label}
        </span>
        <button
          type="button"
          className="mistake-card-close"
          onClick={onDismiss}
          aria-label="Dismiss feedback (Esc)"
          title="Dismiss"
        >
          ×
        </button>
      </div>

      <div className="mistake-card-loss">
        <span className="mistake-card-loss-sign">−</span>
        <span className="mistake-card-loss-num">{formatLoss(feedback.equity_loss)}</span>
      </div>
      <div className="mistake-card-loss-label">equity lost on this move</div>

      {typeof feedback.best_win_probability === "number" &&
      typeof feedback.your_win_probability === "number" ? (
        // Both win probabilities are already from the moving player's POV.
        // The backend's engine.py _flip_post_move_eval (and gnubg's own
        // best_move() return) ensure that — so display them raw and use
        // best - your as the win-prob lost by the mistake.
        <div className="mistake-card-winloss">
          <span className="mistake-card-winloss-lbl">Win % lost</span>
          <span className="mistake-card-winloss-num">
            −{Math.max(0, (feedback.best_win_probability - feedback.your_win_probability) * 100).toFixed(0)}%
          </span>
          <span className="mistake-card-winloss-detail">
            {formatPct(feedback.your_win_probability)} → {formatPct(feedback.best_win_probability)}
          </span>
        </div>
      ) : null}

      <div className="mistake-card-moves">
        <div className="mistake-card-move-line">
          <div>
            <div className="mistake-card-move-lbl">Your move</div>
            <div className="mistake-card-move-play">{formatMove(feedback.your_move)}</div>
          </div>
          <div className="mistake-card-move-eq">
            <div>{formatEquity(feedback.your_equity)}</div>
            {typeof feedback.your_win_probability === "number" ? (
              <div className="mistake-card-move-win">
                {formatPct(feedback.your_win_probability)} win
              </div>
            ) : null}
          </div>
        </div>
        <div className="mistake-card-move-line mistake-card-move-best">
          <div>
            <div className="mistake-card-move-lbl">Best move</div>
            <div className="mistake-card-move-play">{formatMove(feedback.best_move)}</div>
          </div>
          <div className="mistake-card-move-eq">
            <div>{formatEquity(feedback.best_equity)}</div>
            {typeof feedback.best_win_probability === "number" ? (
              <div className="mistake-card-move-win">
                {formatPct(feedback.best_win_probability)} win
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {feedback.explanation &&
      (feedback.explanation.best_reasons.length > 0 ||
        feedback.explanation.your_drawbacks.length > 0) ? (
        <div className="mistake-card-why">
          {feedback.explanation.best_reasons.length > 0 ? (
            <div className="mistake-card-why-block mistake-card-why-best">
              <div className="mistake-card-why-lbl">Why the best move works</div>
              <ul>
                {feedback.explanation.best_reasons.map((reason, i) => (
                  <li key={`best-${i}`}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {feedback.explanation.your_drawbacks.length > 0 ? (
            <div className="mistake-card-why-block mistake-card-why-your">
              <div className="mistake-card-why-lbl">Why your move falls short</div>
              <ul>
                {feedback.explanation.your_drawbacks.map((reason, i) => (
                  <li key={`your-${i}`}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mistake-card-actions">
        {onReplayBest ? (
          <button
            type="button"
            className="mistake-card-btn mistake-card-btn-primary"
            onClick={onReplayBest}
          >
            Replay best
          </button>
        ) : null}
        {onReplayYour ? (
          <button
            type="button"
            className="mistake-card-btn mistake-card-btn-secondary"
            onClick={onReplayYour}
          >
            Replay my move
          </button>
        ) : null}
        {onToggleArrows ? (
          <button
            type="button"
            className="mistake-card-btn mistake-card-btn-ghost"
            onClick={onToggleArrows}
            aria-pressed={arrowsVisible}
          >
            {arrowsVisible ? "Hide on board" : "Show on board"}
          </button>
        ) : null}
      </div>

      {onContinue ? (
        <div className="mistake-card-actions mistake-card-actions-continue">
          <button
            type="button"
            className="mistake-card-btn mistake-card-btn-continue"
            onClick={onContinue}
          >
            Continue to opponent's turn
          </button>
        </div>
      ) : null}

      {footerTags.length > 0 ? (
        <div className="mistake-card-footer">
          {footerTags.map((t) => (
            <span key={t} className="mistake-card-tag">{t}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
