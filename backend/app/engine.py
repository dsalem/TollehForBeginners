from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
import json
from math import exp
import subprocess
import sys
import threading
from typing import Any

from .domain import BoardState, DiceRoll, PlayerColor, TurnMove

try:
    import gnubg_nn  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    gnubg_nn = None


_GNUBG_ROLLOUT_LOCK = threading.Lock()


def _extract_rollout_probabilities(rollout_result: Any) -> Any:
    if (
        isinstance(rollout_result, (tuple, list))
        and len(rollout_result) == 2
        and isinstance(rollout_result[0], (tuple, list))
    ):
        return rollout_result[0]
    return rollout_result


def _run_rollout_subprocess(
    gnubg_board: list[list[int]],
    rollout_games: int,
    n_plies: int,
) -> tuple[float, float, float, float, float]:
    payload = json.dumps(
        {
            "board": gnubg_board,
            "ngames": rollout_games,
            "n": n_plies,
        }
    )
    script = (
        "import json, sys, gnubg_nn\n"
        "data=json.loads(sys.argv[1])\n"
        "key=gnubg_nn.key_of_board(data['board'])\n"
        "r=gnubg_nn.rollout(key, ngames=int(data['ngames']), n=int(data['n']))\n"
        "print(json.dumps(r))\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script, payload],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        raise RuntimeError(
            f"rollout subprocess failed with code {completed.returncode}: {stderr}"
        )

    stdout = completed.stdout.strip()
    if not stdout:
        raise RuntimeError("rollout subprocess returned no output")

    rollout_result = json.loads(stdout)
    probabilities = _extract_rollout_probabilities(rollout_result)
    return (
        float(probabilities[0]),
        float(probabilities[1]),
        float(probabilities[2]),
        float(probabilities[3]),
        float(probabilities[4]),
    )


@dataclass
class EvaluationResult:
    equity: float
    win_probability: float
    gammon_win_probability: float
    backgammon_win_probability: float
    lose_probability: float
    gammon_lose_probability: float
    backgammon_lose_probability: float


@dataclass
class MoveCandidate:
    move: TurnMove
    resulting_board: BoardState
    evaluation: EvaluationResult
    equity: float


@dataclass
class MoveAnalysisResult:
    best_move: MoveCandidate | None
    candidates: list[MoveCandidate]
    ranking_method: str = ""
    rollout_used: bool = False
    rollout_candidates_scored: int = 0
    rollout_errors: list[str] | None = None
    opening_book_applied: bool = False


class BackgammonEngine(ABC):
    @abstractmethod
    def evaluate_position(
        self, board_state: BoardState, player_color: PlayerColor
    ) -> EvaluationResult:
        raise NotImplementedError

    @abstractmethod
    def rank_moves(
        self,
        board_state_before_move: BoardState,
        dice_roll: DiceRoll,
        player_color: PlayerColor,
        deduplicate_final_states: bool = True,
    ) -> MoveAnalysisResult:
        raise NotImplementedError


def _as_money_equity(
    win_probability: float,
    gammon_win_probability: float,
    backgammon_win_probability: float,
    gammon_lose_probability: float,
    backgammon_lose_probability: float,
) -> float:
    # GNU Backgammon style money equity from cubeless outcome probabilities.
    return (
        2.0 * win_probability
        - 1.0
        + gammon_win_probability
        + backgammon_win_probability
        - gammon_lose_probability
        - backgammon_lose_probability
    )


def _clamp_probability(value: float) -> float:
    return max(0.0, min(1.0, value))


# Opening-book entries use WHITE perspective coordinates.
# Key is normalized dice (higher, lower), value is exact checker moves.
OPENING_BOOK_WHITE: dict[tuple[int, int], list[tuple[int, int]]] = {
    (1, 1): [(13, 11), (13, 11), (6, 5), (6, 5)],

    (2, 1): [(13, 11), (6, 5)],
    (3, 1): [(8, 5), (6, 5)],
    (4, 1): [(13, 9), (24, 23)],
    (5, 1): [(24, 23), (13, 8)],
    (6, 1): [(13, 7), (8, 7)],

    (2, 2): [(13, 11), (13, 11), (6, 4), (6, 4)],

    (3, 2): [(24, 21), (13, 11)],
    (4, 2): [(8, 4), (6, 4)],
    (5, 2): [(24, 22), (13, 8)],
    (6, 2): [(24, 18), (13, 11)],

    (3, 3): [(8, 5), (8, 5), (6, 3), (6, 3)],

    (4, 3): [(13, 9), (13, 10)],
    (5, 3): [(8, 3), (6, 3)],
    (6, 3): [(24, 18), (13, 10)],

    (4, 4): [(24, 20), (24, 20), (13, 9), (13, 9)],

    (5, 4): [(13, 9), (13, 8)],
    (6, 4): [(24, 18), (13, 9)],

    (5, 5): [(24, 19), (24, 19), (13, 8), (13, 8)],

    (6, 5): [(24, 18), (18, 13)],

    (6, 6): [(24, 18), (24, 18), (13, 7), (13, 7)],
}


_INITIAL_BOARD_SIGNATURE = BoardState.initial().signature()


def _normalize_dice_pair(dice_roll: DiceRoll) -> tuple[int, int]:
    return tuple(sorted((dice_roll.die_1, dice_roll.die_2), reverse=True))


def _is_opening_position(board_state: BoardState) -> bool:
    return board_state.signature() == _INITIAL_BOARD_SIGNATURE


def _mirror_point(point_number: int) -> int:
    return 25 - point_number


def _opening_book_moves_for_player(
    dice_roll: DiceRoll, player_color: PlayerColor
) -> list[tuple[int, int]] | None:
    white_moves = OPENING_BOOK_WHITE.get(_normalize_dice_pair(dice_roll))
    if white_moves is None:
        return None

    if player_color == PlayerColor.WHITE:
        return white_moves

    return [(_mirror_point(src), _mirror_point(dst)) for src, dst in white_moves]


def _normalized_turn_move_edges(turn_move: TurnMove) -> list[tuple[int, int]]:
    edges: list[tuple[int, int]] = []
    for move in turn_move.moves:
        if move.from_bar or move.to_borne_off:
            return []
        if move.from_point is None or move.to_point is None:
            return []
        edges.append((move.from_point, move.to_point))
    return sorted(edges)


def _prefer_opening_book_candidate(
    board_state_before_move: BoardState,
    dice_roll: DiceRoll,
    player_color: PlayerColor,
    candidates: list[MoveCandidate],
) -> tuple[list[MoveCandidate], bool]:
    if not candidates or not _is_opening_position(board_state_before_move):
        return candidates, False

    book_moves = _opening_book_moves_for_player(dice_roll, player_color)
    if not book_moves:
        return candidates, False

    target_edges = sorted(book_moves)
    for index, candidate in enumerate(candidates):
        if _normalized_turn_move_edges(candidate.move) == target_edges:
            if index == 0:
                return candidates, False
            return [candidate, *candidates[:index], *candidates[index + 1 :]], True

    return candidates, False


def _pip_count(board_state: BoardState, player: PlayerColor) -> int:
    pip_total = board_state.bar_counts[player] * 25

    for point_number, point in enumerate(board_state.points, start=1):
        if point.owner != player or point.checker_count <= 0:
            continue

        distance = point_number if player == PlayerColor.WHITE else 25 - point_number
        pip_total += distance * point.checker_count

    return pip_total


def _blot_count(board_state: BoardState, player: PlayerColor) -> int:
    return sum(
        1
        for point in board_state.points
        if point.owner == player and point.checker_count == 1
    )


def _made_point_count(board_state: BoardState, player: PlayerColor) -> int:
    return sum(
        1
        for point in board_state.points
        if point.owner == player and point.checker_count >= 2
    )


class DummyEngine(BackgammonEngine):
    """Simple heuristic evaluator used until a stronger engine is integrated."""

    def evaluate_position(
        self, board_state: BoardState, player_color: PlayerColor
    ) -> EvaluationResult:
        opponent = BoardState.opponent(player_color)

        player_borne_off = board_state.borne_off_counts[player_color]
        opponent_borne_off = board_state.borne_off_counts[opponent]
        borne_off_diff = player_borne_off - opponent_borne_off

        player_pip = _pip_count(board_state, player_color)
        opponent_pip = _pip_count(board_state, opponent)
        pip_diff = opponent_pip - player_pip

        player_blots = _blot_count(board_state, player_color)
        opponent_blots = _blot_count(board_state, opponent)
        blot_diff = opponent_blots - player_blots

        player_made_points = _made_point_count(board_state, player_color)
        opponent_made_points = _made_point_count(board_state, opponent)
        made_point_diff = player_made_points - opponent_made_points

        bar_diff = board_state.bar_counts[opponent] - board_state.bar_counts[player_color]

        equity = (
            0.32 * borne_off_diff
            + 0.012 * pip_diff
            + 0.085 * made_point_diff
            + 0.065 * blot_diff
            + 0.13 * bar_diff
        )

        win_probability = _clamp_probability(1.0 / (1.0 + exp(-2.2 * equity)))
        lose_probability = 1.0 - win_probability

        gammon_win_probability = win_probability * _clamp_probability(
            0.04 + 0.018 * max(0, borne_off_diff) + 0.02 * max(0, bar_diff)
        )
        backgammon_win_probability = win_probability * _clamp_probability(
            0.005 + 0.01 * max(0, bar_diff) + 0.005 * max(0, made_point_diff)
        )

        gammon_lose_probability = lose_probability * _clamp_probability(
            0.04 + 0.018 * max(0, -borne_off_diff) + 0.02 * max(0, -bar_diff)
        )
        backgammon_lose_probability = lose_probability * _clamp_probability(
            0.005 + 0.01 * max(0, -bar_diff) + 0.005 * max(0, -made_point_diff)
        )

        gammon_win_probability = min(gammon_win_probability, win_probability * 0.65)
        backgammon_win_probability = min(backgammon_win_probability, win_probability * 0.3)
        gammon_lose_probability = min(gammon_lose_probability, lose_probability * 0.65)
        backgammon_lose_probability = min(
            backgammon_lose_probability, lose_probability * 0.3
        )

        return EvaluationResult(
            equity=equity,
            win_probability=win_probability,
            gammon_win_probability=gammon_win_probability,
            backgammon_win_probability=backgammon_win_probability,
            lose_probability=lose_probability,
            gammon_lose_probability=gammon_lose_probability,
            backgammon_lose_probability=backgammon_lose_probability,
        )

    def rank_moves(
        self,
        board_state_before_move: BoardState,
        dice_roll: DiceRoll,
        player_color: PlayerColor,
        deduplicate_final_states: bool = True,
    ) -> MoveAnalysisResult:
        legal_moves = board_state_before_move.generate_legal_turn_moves(
            player=player_color,
            dice_roll=dice_roll,
            deduplicate_final_states=deduplicate_final_states,
        )

        candidates: list[MoveCandidate] = []
        for legal_move in legal_moves:
            resulting_board = board_state_before_move.copy()
            for single_move in legal_move.moves:
                resulting_board.apply_single_checker_move(single_move)

            evaluation = self.evaluate_position(resulting_board, player_color)
            candidates.append(
                MoveCandidate(
                    move=legal_move,
                    resulting_board=resulting_board,
                    evaluation=evaluation,
                    equity=evaluation.equity,
                )
            )

        candidates.sort(key=lambda candidate: candidate.equity, reverse=True)
        candidates, opening_book_applied = _prefer_opening_book_candidate(
            board_state_before_move=board_state_before_move,
            dice_roll=dice_roll,
            player_color=player_color,
            candidates=candidates,
        )
        return MoveAnalysisResult(
            best_move=candidates[0] if candidates else None,
            candidates=candidates,
            ranking_method=(
                "Dummy heuristic equity (borne-off, pip count, blots, made points, bar)."
            ),
            rollout_used=False,
            rollout_candidates_scored=0,
            opening_book_applied=opening_book_applied,
        )


class GnuBgEngine(DummyEngine):
    """GnuBg-backed evaluator with automatic fallback to DummyEngine."""

    def __init__(
        self,
        fallback_engine: BackgammonEngine | None = None,
        n_plies: int = 0,
        use_rollout_for_ranking: bool = True,
        use_rollout_subprocess: bool = True,
        rollout_games: int = 324,
        rollout_top_k: int = 3,
        rollout_level: int = 3,
        rollout_trials: int = 300,
    ) -> None:
        self._fallback_engine = fallback_engine or DummyEngine()
        self._n_plies = n_plies
        self._use_rollout_for_ranking = use_rollout_for_ranking
        self._use_rollout_subprocess = use_rollout_subprocess
        self._rollout_games = rollout_games
        self._rollout_top_k = rollout_top_k
        self._rollout_level = rollout_level
        self._rollout_trials = rollout_trials

    @staticmethod
    def is_available() -> bool:
        return gnubg_nn is not None

    @staticmethod
    def _point_for_perspective(
        point_number: int, perspective_player: PlayerColor
    ) -> int:
        if perspective_player == PlayerColor.WHITE:
            return point_number
        return 25 - point_number

    @classmethod
    def _build_gnubg_row_for_player(
        cls, board_state: BoardState, perspective_player: PlayerColor
    ) -> list[int]:
        # gnubg-nn expects points 1..24 in indices 0..23 and bar at index 24.
        row = [0] * 25

        for point_number, point in enumerate(board_state.points, start=1):
            if point.owner != perspective_player or point.checker_count <= 0:
                continue
            perspective_point = cls._point_for_perspective(
                point_number, perspective_player
            )
            row[perspective_point - 1] += point.checker_count

        row[24] = board_state.bar_counts[perspective_player]
        return row

    @classmethod
    def board_state_to_gnubg_board(
        cls, board_state: BoardState, player_color: PlayerColor
    ) -> list[list[int]]:
        """
        Convert our absolute board representation into gnubg-nn's 2x25 board:
        - row 0: opponent perspective
        - row 1: player perspective (probabilities are returned for this side)
        - indices 0..23: points 1..24
        - index 24: bar
        - borne-off is implicit (15 - row sum)
        """
        opponent = BoardState.opponent(player_color)
        opponent_row = cls._build_gnubg_row_for_player(board_state, opponent)
        player_row = cls._build_gnubg_row_for_player(board_state, player_color)
        return [opponent_row, player_row]

    def _evaluate_with_gnubg(
        self, board_state: BoardState, player_color: PlayerColor
    ) -> EvaluationResult:
        if gnubg_nn is None:
            raise RuntimeError("gnubg_nn is unavailable")

        gnubg_board = self.board_state_to_gnubg_board(board_state, player_color)
        raw_probabilities: Any = gnubg_nn.probabilities(gnubg_board, self._n_plies)

        return self._evaluation_from_probabilities(raw_probabilities)

    def _native_rank_candidates(
        self,
        board_state_before_move: BoardState,
        dice_roll: DiceRoll,
        player_color: PlayerColor,
        deduplicate_final_states: bool,
    ) -> list[MoveCandidate]:
        if gnubg_nn is None:
            raise RuntimeError("gnubg_nn is unavailable")

        legal_moves = board_state_before_move.generate_legal_turn_moves(
            player=player_color,
            dice_roll=dice_roll,
            deduplicate_final_states=deduplicate_final_states,
        )

        if not legal_moves:
            return []

        legal_candidates_by_key: dict[str, MoveCandidate] = {}
        unmatched_candidates: list[MoveCandidate] = []
        opponent_color = BoardState.opponent(player_color)
        for legal_move in legal_moves:
            resulting_board = board_state_before_move.copy()
            for single_move in legal_move.moves:
                resulting_board.apply_single_checker_move(single_move)

            # Post-move: the opponent is on roll, so evaluate from their POV
            # and flip the result. Evaluating with player_color at board[1]
            # gives the just-moved player a phantom on-roll bonus.
            opp_evaluation = self.evaluate_position(resulting_board, opponent_color)
            evaluation = self._flip_post_move_eval(opp_evaluation)
            candidate = MoveCandidate(
                move=legal_move,
                resulting_board=resulting_board,
                evaluation=evaluation,
                equity=evaluation.equity,
            )
            unmatched_candidates.append(candidate)
            try:
                gnubg_board = self.board_state_to_gnubg_board(
                    resulting_board, player_color
                )
                # gnubg_nn.best_move() returns candidate keys with the current
                # player row first, while our evaluation helpers use opponent
                # row first. Swap rows here so we match GNUBG's candidate list.
                key = gnubg_nn.key_of_board([gnubg_board[1], gnubg_board[0]])
                legal_candidates_by_key[key] = candidate
            except Exception:
                continue

        gnubg_board = self.board_state_to_gnubg_board(board_state_before_move, player_color)
        best_move_result = gnubg_nn.best_move(
            gnubg_board,
            dice_roll.die_1,
            dice_roll.die_2,
            self._n_plies,
            b"X",
            0,
            0,
            1,
            0,
        )
        if not isinstance(best_move_result, tuple) or len(best_move_result) < 2:
            return unmatched_candidates

        raw_ranked_candidates = best_move_result[1]
        ranked_candidates: list[MoveCandidate] = []
        used_keys: set[str] = set()

        for raw_candidate in raw_ranked_candidates:
            if not isinstance(raw_candidate, tuple) or len(raw_candidate) < 4:
                continue

            candidate_key = raw_candidate[0]
            raw_probabilities = raw_candidate[2]
            raw_equity = raw_candidate[3]
            if not isinstance(candidate_key, str):
                continue

            existing_candidate = legal_candidates_by_key.get(candidate_key)
            if existing_candidate is None:
                continue

            # gnubg's best_move() already returns post-move evaluations
            # from the moving player's POV with the opponent on roll
            # (i.e., correctly handles the perspective flip internally).
            # Verified empirically: best_move's raw_win for "13/8 24/23"
            # matches BLACK-on-roll perspective (0.499), not WHITE-on-roll
            # (0.542). So no flip needed here.
            evaluation = self._evaluation_from_probabilities(raw_probabilities)
            ranked_candidates.append(
                MoveCandidate(
                    move=existing_candidate.move,
                    resulting_board=existing_candidate.resulting_board,
                    evaluation=evaluation,
                    equity=float(raw_equity),
                )
            )
            used_keys.add(candidate_key)

        if not ranked_candidates:
            return unmatched_candidates

        for key, candidate in legal_candidates_by_key.items():
            if key not in used_keys:
                ranked_candidates.append(candidate)

        return ranked_candidates

    @staticmethod
    def _flip_post_move_eval(opp_eval: EvaluationResult) -> EvaluationResult:
        """Convert an evaluation taken from the opponent's POV (with the
        opponent on roll, which is the post-move reality) back into the
        moving player's POV. Equity inverts; win/lose probabilities swap;
        gammon-win swaps with gammon-lose; backgammon-win swaps with
        backgammon-lose. Without this, a post-move evaluation done with
        the just-moved player at board[1] gives them a phantom on-roll
        bonus and badly inflates their win probability.
        """
        return EvaluationResult(
            equity=-opp_eval.equity,
            win_probability=1.0 - opp_eval.win_probability,
            gammon_win_probability=opp_eval.gammon_lose_probability,
            backgammon_win_probability=opp_eval.backgammon_lose_probability,
            lose_probability=opp_eval.win_probability,
            gammon_lose_probability=opp_eval.gammon_win_probability,
            backgammon_lose_probability=opp_eval.backgammon_win_probability,
        )

    @staticmethod
    def _evaluation_from_probabilities(raw_probabilities: Any) -> EvaluationResult:
        win_probability = _clamp_probability(float(raw_probabilities[0]))
        gammon_win_probability = _clamp_probability(float(raw_probabilities[1]))
        backgammon_win_probability = _clamp_probability(float(raw_probabilities[2]))
        gammon_lose_probability = _clamp_probability(float(raw_probabilities[3]))
        backgammon_lose_probability = _clamp_probability(float(raw_probabilities[4]))
        lose_probability = _clamp_probability(1.0 - win_probability)

        equity = _as_money_equity(
            win_probability=win_probability,
            gammon_win_probability=gammon_win_probability,
            backgammon_win_probability=backgammon_win_probability,
            gammon_lose_probability=gammon_lose_probability,
            backgammon_lose_probability=backgammon_lose_probability,
        )

        return EvaluationResult(
            equity=equity,
            win_probability=win_probability,
            gammon_win_probability=gammon_win_probability,
            backgammon_win_probability=backgammon_win_probability,
            lose_probability=lose_probability,
            gammon_lose_probability=gammon_lose_probability,
            backgammon_lose_probability=backgammon_lose_probability,
        )

    def _evaluate_with_rollout(
        self, board_state: BoardState, player_color: PlayerColor
    ) -> EvaluationResult:
        if gnubg_nn is None:
            raise RuntimeError("gnubg_nn is unavailable")

        gnubg_board = self.board_state_to_gnubg_board(board_state, player_color)
        if self._use_rollout_subprocess:
            probabilities: Any = _run_rollout_subprocess(
                gnubg_board,
                self._rollout_games,
                self._n_plies,
            )
        else:
            position_id = gnubg_nn.position_id(gnubg_board)
            with _GNUBG_ROLLOUT_LOCK:
                rollout_result: Any = gnubg_nn.rollout(
                    position_id,
                    ngames=self._rollout_games,
                    n=self._n_plies,
                    level=self._rollout_level,
                    nt=self._rollout_trials,
                    std=0,
                )
            probabilities = _extract_rollout_probabilities(rollout_result)

        return self._evaluation_from_probabilities(probabilities)

    def _can_use_rollout_in_current_thread(self) -> bool:
        """
        gnubg_nn.rollout may crash in non-main threads on some platforms.
        Subprocess rollout is thread-safe from the API server threadpool.
        """
        if self._use_rollout_subprocess:
            return True
        return threading.current_thread() is threading.main_thread()

    def evaluate_position(
        self, board_state: BoardState, player_color: PlayerColor
    ) -> EvaluationResult:
        if not self.is_available():
            return self._fallback_engine.evaluate_position(board_state, player_color)

        try:
            return self._evaluate_with_gnubg(board_state, player_color)
        except Exception:
            return self._fallback_engine.evaluate_position(board_state, player_color)

    def rank_moves(
        self,
        board_state_before_move: BoardState,
        dice_roll: DiceRoll,
        player_color: PlayerColor,
        deduplicate_final_states: bool = True,
    ) -> MoveAnalysisResult:
        if self.is_available():
            try:
                candidates = self._native_rank_candidates(
                    board_state_before_move=board_state_before_move,
                    dice_roll=dice_roll,
                    player_color=player_color,
                    deduplicate_final_states=deduplicate_final_states,
                )
            except Exception:
                candidates = []
        else:
            candidates = []

        if not candidates:
            fallback = self._fallback_engine.rank_moves(
                board_state_before_move=board_state_before_move,
                dice_roll=dice_roll,
                player_color=player_color,
                deduplicate_final_states=deduplicate_final_states,
            )
            return MoveAnalysisResult(
                best_move=fallback.best_move,
                candidates=fallback.candidates,
                ranking_method="gnubg-nn unavailable; fallback to Dummy heuristic equity.",
                rollout_used=False,
                rollout_candidates_scored=0,
                rollout_errors=None,
                opening_book_applied=fallback.opening_book_applied,
            )

        rollout_scored = 0
        rollout_errors: list[str] = []
        rollout_condition = (
            self.is_available()
            and self._use_rollout_for_ranking
            and self._can_use_rollout_in_current_thread()
            and candidates
        )
        if rollout_condition:
            rollout_opponent = BoardState.opponent(player_color)
            rollout_count = min(max(1, self._rollout_top_k), len(candidates))
            for index in range(rollout_count):
                candidate = candidates[index]
                try:
                    # Roll out from the post-move position with the OPPONENT
                    # on roll (which is what actually happens next), then flip.
                    # Otherwise gnubg simulates a phantom free turn for the
                    # just-moved player and inflates their win probability.
                    opp_rollout_eval = self._evaluate_with_rollout(
                        candidate.resulting_board, rollout_opponent
                    )
                    rollout_eval = self._flip_post_move_eval(opp_rollout_eval)
                except Exception as exc:
                    rollout_errors.append(
                        f"candidate {index + 1}: {exc.__class__.__name__}: {exc}"
                    )
                    continue
                candidates[index] = MoveCandidate(
                    move=candidate.move,
                    resulting_board=candidate.resulting_board,
                    evaluation=rollout_eval,
                    equity=rollout_eval.equity,
                )
                rollout_scored += 1

            candidates.sort(key=lambda candidate: candidate.equity, reverse=True)

        # Keep the live GNUBG engine ranking authoritative. We do not force an
        # opening-book move to the top here because that can contradict the
        # displayed equities and make the analysis list internally inconsistent.
        opening_book_applied = False

        if not self.is_available():
            ranking_method = (
                "gnubg-nn unavailable; fallback to Dummy heuristic equity."
            )
        elif rollout_condition and rollout_scored > 0:
            ranking_method = (
                "GNU Backgammon native move ranking + rollout re-ranking for top candidates."
            )
        elif rollout_condition:
            if rollout_errors:
                ranking_method = (
                    "GNU Backgammon native move ranking; rollout attempted but failed for all candidates."
                )
            else:
                ranking_method = (
                    "GNU Backgammon native move ranking; rollout attempted but not applied."
                )
        elif self._use_rollout_for_ranking:
            ranking_method = (
                "GNU Backgammon native move ranking only (rollout skipped because subprocess rollout is disabled)."
            )
        else:
            ranking_method = "GNU Backgammon native move ranking only (rollout disabled)."

        return MoveAnalysisResult(
            best_move=candidates[0] if candidates else None,
            candidates=candidates,
            ranking_method=ranking_method,
            rollout_used=rollout_scored > 0,
            rollout_candidates_scored=rollout_scored,
            rollout_errors=rollout_errors or None,
            opening_book_applied=opening_book_applied,
        )


def create_default_engine(n_plies: int = 0) -> BackgammonEngine:
    return GnuBgEngine(n_plies=n_plies, use_rollout_for_ranking=False)
