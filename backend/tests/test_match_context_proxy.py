from backend.app.domain import BoardState, GameMode, GameState, PlayerColor, TurnMove, DiceRoll
from backend.app.engine import EvaluationResult, MoveAnalysisResult, MoveCandidate
from backend.app.main import _apply_match_context_to_analysis


def _candidate(equity: float) -> MoveCandidate:
    evaluation = EvaluationResult(
        equity=equity,
        win_probability=0.55 if equity >= 0 else 0.45,
        gammon_win_probability=0.10,
        backgammon_win_probability=0.01,
        lose_probability=0.45 if equity >= 0 else 0.55,
        gammon_lose_probability=0.09,
        backgammon_lose_probability=0.01,
    )
    return MoveCandidate(
        move=TurnMove(player=PlayerColor.WHITE, dice_roll=DiceRoll(6, 2), moves=[]),
        resulting_board=BoardState.initial(),
        evaluation=evaluation,
        equity=equity,
    )


def test_match_proxy_is_not_applied_in_early_match_at_cube_1() -> None:
    game = GameState.new_game("g1", GameMode.LOCAL, match_length=5)
    analysis = MoveAnalysisResult(
        best_move=None,
        candidates=[_candidate(0.10), _candidate(0.05)],
        ranking_method="base",
    )

    adjusted = _apply_match_context_to_analysis(analysis, game, PlayerColor.WHITE)

    assert adjusted.ranking_method == "base"
    assert [c.equity for c in adjusted.candidates] == [0.10, 0.05]


def test_match_proxy_is_applied_when_near_match_end() -> None:
    game = GameState.new_game("g1", GameMode.LOCAL, match_length=5)
    game.cube_value = 2
    game.score_white = 3  # 2-away
    game.score_black = 1  # 4-away
    analysis = MoveAnalysisResult(
        best_move=None,
        candidates=[_candidate(0.10), _candidate(0.05)],
        ranking_method="base",
    )

    adjusted = _apply_match_context_to_analysis(analysis, game, PlayerColor.WHITE)

    assert "Match-aware proxy applied" in adjusted.ranking_method
    assert adjusted.candidates[0].equity >= adjusted.candidates[1].equity
