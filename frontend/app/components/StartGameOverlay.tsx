"use client";

/**
 * Empty-board "Start a Game" overlay.
 *
 * Shown when no game is active. Floats inside the board-shell, sized to
 * the felt area. Uses the existing top-level handlers (handleNewLocalGame
 * etc.) so the underlying game-creation logic is unchanged.
 */

type ComputerDifficulty = "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT";

type GameStats = {
  vsComputer: { wins: number; losses: number };
  online: { wins: number; losses: number };
  local: { games: number };
};

type Props = {
  isBusy: boolean;
  matchLength: 1 | 3 | 5 | 7 | 9;
  setMatchLength: (n: 1 | 3 | 5 | 7 | 9) => void;
  computerDifficulty: ComputerDifficulty;
  setComputerDifficulty: (d: ComputerDifficulty) => void;
  joinCodeInput: string;
  setJoinCodeInput: (s: string) => void;
  onPlayComputer: () => void;
  onPlayLocal: () => void;
  onCreateOnline: () => void;
  onJoinOnline: () => void;
  stats?: GameStats;
  onResetStats?: () => void;
};

export default function StartGameOverlay({
  isBusy,
  matchLength,
  setMatchLength,
  computerDifficulty,
  setComputerDifficulty,
  joinCodeInput,
  setJoinCodeInput,
  onPlayComputer,
  onPlayLocal,
  onCreateOnline,
  onJoinOnline,
  stats,
  onResetStats,
}: Props) {
  return (
    <div className="start-overlay" role="dialog" aria-modal="true" aria-labelledby="start-overlay-title">
      <div className="start-overlay-card">
        <div className="start-overlay-eyebrow">Tolleh · Backgammon</div>
        <h2 id="start-overlay-title" className="start-overlay-title">Start a game</h2>
        <p className="start-overlay-sub">
          Choose how you want to play. You can change match length and difficulty before you begin.
        </p>

        <div className="start-overlay-controls">
          <label className="start-overlay-control">
            <span>Match length</span>
            <select
              value={matchLength}
              onChange={(e) => setMatchLength(Number(e.target.value) as 1 | 3 | 5 | 7 | 9)}
              disabled={isBusy}
            >
              <option value={1}>1 point</option>
              <option value={3}>3 points</option>
              <option value={5}>5 points</option>
              <option value={7}>7 points</option>
              <option value={9}>9 points</option>
            </select>
          </label>

          <label className="start-overlay-control">
            <span>Computer level</span>
            <select
              value={computerDifficulty}
              onChange={(e) => setComputerDifficulty(e.target.value as ComputerDifficulty)}
              disabled={isBusy}
            >
              <option value="BEGINNER">Beginner</option>
              <option value="INTERMEDIATE">Intermediate</option>
              <option value="ADVANCED">Advanced</option>
              <option value="EXPERT">Expert</option>
            </select>
          </label>
        </div>

        <div className="start-overlay-actions">
          <button
            type="button"
            className="start-overlay-btn start-overlay-btn-primary"
            onClick={onPlayComputer}
            disabled={isBusy}
          >
            Play vs Computer
          </button>
          <button
            type="button"
            className="start-overlay-btn"
            onClick={onPlayLocal}
            disabled={isBusy}
          >
            Local 2-Player
          </button>
        </div>

        <div className="start-overlay-divider"><span>or play online</span></div>

        <div className="start-overlay-online">
          <button
            type="button"
            className="start-overlay-btn start-overlay-btn-ghost"
            onClick={onCreateOnline}
            disabled={isBusy}
          >
            Create lobby
          </button>
          <div className="start-overlay-join">
            <input
              value={joinCodeInput}
              onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              disabled={isBusy}
              aria-label="Join code"
            />
            <button
              type="button"
              className="start-overlay-btn start-overlay-btn-ghost"
              onClick={onJoinOnline}
              disabled={isBusy || joinCodeInput.trim().length === 0}
            >
              Join
            </button>
          </div>
        </div>

        {stats ? (
          <div className="start-overlay-stats">
            <div className="start-overlay-stats-row">
              <span>vs Computer</span>
              <strong>
                {stats.vsComputer.wins}W – {stats.vsComputer.losses}L
              </strong>
            </div>
            <div className="start-overlay-stats-row">
              <span>Online</span>
              <strong>
                {stats.online.wins}W – {stats.online.losses}L
              </strong>
            </div>
            <div className="start-overlay-stats-row">
              <span>Local 2-Player</span>
              <strong>{stats.local.games} played</strong>
            </div>
            {onResetStats &&
            (stats.vsComputer.wins +
              stats.vsComputer.losses +
              stats.online.wins +
              stats.online.losses +
              stats.local.games >
              0) ? (
              <button
                type="button"
                className="start-overlay-stats-reset"
                onClick={onResetStats}
                disabled={isBusy}
              >
                Reset record
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
