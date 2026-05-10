from backend.app.domain import BoardState, DiceRoll, PlayerColor, Point
from backend.app.engine import EvaluationResult, GnuBgEngine, MoveCandidate


def _set_point(
    board: BoardState, point_number: int, owner: PlayerColor, checker_count: int
) -> None:
    board.points[point_number - 1] = Point(owner=owner, checker_count=checker_count)


def _simple_eval(equity: float) -> EvaluationResult:
    win = 0.5 if equity >= 0 else 0.45
    return EvaluationResult(
        equity=equity,
        win_probability=win,
        gammon_win_probability=0.05,
        backgammon_win_probability=0.01,
        lose_probability=1.0 - win,
        gammon_lose_probability=0.05,
        backgammon_lose_probability=0.01,
    )


def test_rollout_ranking_changes_best_move_when_enabled(monkeypatch) -> None:
    board = BoardState.empty()
    _set_point(board, 8, PlayerColor.WHITE, 2)
    _set_point(board, 6, PlayerColor.WHITE, 2)
    _set_point(board, 5, PlayerColor.BLACK, 1)
    dice = DiceRoll(1, 2)

    engine = GnuBgEngine(use_rollout_for_ranking=True, rollout_top_k=2)
    monkeypatch.setattr(engine, "is_available", lambda: True)

    legal_turns = board.generate_legal_turn_moves(
        player=PlayerColor.WHITE,
        dice_roll=dice,
        deduplicate_final_states=False,
    )
    assert len(legal_turns) >= 2

    candidates = []
    signatures_by_turn = {}
    for turn in legal_turns:
        resulting = board.copy()
        for move in turn.moves:
            resulting.apply_single_checker_move(move)
        turn_key = tuple((m.from_point, m.to_point) for m in turn.moves)
        signatures_by_turn[turn_key] = resulting.signature()
        candidates.append(
            MoveCandidate(
                move=turn,
                resulting_board=resulting,
                evaluation=_simple_eval(0.0),
                equity=0.0,
            )
        )

    first_turn = legal_turns[0]
    second_turn = legal_turns[1]
    first_key = tuple((m.from_point, m.to_point) for m in first_turn.moves)
    second_key = tuple((m.from_point, m.to_point) for m in second_turn.moves)
    first_sig = signatures_by_turn[first_key]
    second_sig = signatures_by_turn[second_key]

    def fake_static_eval(state: BoardState, _player: PlayerColor) -> EvaluationResult:
        if state.signature() == first_sig:
            return _simple_eval(0.9)
        if state.signature() == second_sig:
            return _simple_eval(0.8)
        return _simple_eval(0.0)

    def fake_rollout_eval(state: BoardState, _player: PlayerColor) -> EvaluationResult:
        # _evaluate_with_rollout is now called with the opponent as the
        # on-roll player (post-move convention), and the engine flips the
        # result. So mock values are in opponent-POV: positive = bad for
        # mover, negative = good for mover.
        if state.signature() == first_sig:
            return _simple_eval(0.5)   # mover's true equity = -0.5 (worst)
        if state.signature() == second_sig:
            return _simple_eval(-1.2)  # mover's true equity = +1.2 (best)
        return _simple_eval(0.0)

    def fake_native_rank_candidates(*_args, **_kwargs):
        ranked = []
        for candidate in candidates:
            evaluation = fake_static_eval(candidate.resulting_board, PlayerColor.WHITE)
            ranked.append(
                MoveCandidate(
                    move=candidate.move,
                    resulting_board=candidate.resulting_board,
                    evaluation=evaluation,
                    equity=evaluation.equity,
                )
            )
        ranked.sort(key=lambda candidate: candidate.equity, reverse=True)
        return ranked

    monkeypatch.setattr(engine, "_native_rank_candidates", fake_native_rank_candidates)
    monkeypatch.setattr(engine, "_evaluate_with_rollout", fake_rollout_eval)

    analysis = engine.rank_moves(board, dice, PlayerColor.WHITE, deduplicate_final_states=False)
    best_edges = tuple((m.from_point, m.to_point) for m in analysis.best_move.move.moves)
    assert best_edges == second_key


def test_rollout_ranking_not_used_when_disabled(monkeypatch) -> None:
    board = BoardState.empty()
    _set_point(board, 8, PlayerColor.WHITE, 2)
    _set_point(board, 6, PlayerColor.WHITE, 2)
    _set_point(board, 5, PlayerColor.BLACK, 1)
    dice = DiceRoll(1, 2)

    engine = GnuBgEngine(use_rollout_for_ranking=False, rollout_top_k=2)
    monkeypatch.setattr(engine, "is_available", lambda: True)

    legal_turns = board.generate_legal_turn_moves(
        player=PlayerColor.WHITE,
        dice_roll=dice,
        deduplicate_final_states=False,
    )
    assert len(legal_turns) >= 2

    candidates = []
    signatures_by_turn = {}
    for turn in legal_turns:
        resulting = board.copy()
        for move in turn.moves:
            resulting.apply_single_checker_move(move)
        turn_key = tuple((m.from_point, m.to_point) for m in turn.moves)
        signatures_by_turn[turn_key] = resulting.signature()
        candidates.append(
            MoveCandidate(
                move=turn,
                resulting_board=resulting,
                evaluation=_simple_eval(0.0),
                equity=0.0,
            )
        )

    first_turn = legal_turns[0]
    second_turn = legal_turns[1]
    first_key = tuple((m.from_point, m.to_point) for m in first_turn.moves)
    second_key = tuple((m.from_point, m.to_point) for m in second_turn.moves)
    first_sig = signatures_by_turn[first_key]
    second_sig = signatures_by_turn[second_key]

    def fake_static_eval(state: BoardState, _player: PlayerColor) -> EvaluationResult:
        if state.signature() == first_sig:
            return _simple_eval(1.0)
        if state.signature() == second_sig:
            return _simple_eval(0.2)
        return _simple_eval(0.0)

    def fail_rollout(*_args, **_kwargs) -> EvaluationResult:
        raise AssertionError("rollout should not be called when disabled")

    def fake_native_rank_candidates(*_args, **_kwargs):
        ranked = []
        for candidate in candidates:
            evaluation = fake_static_eval(candidate.resulting_board, PlayerColor.WHITE)
            ranked.append(
                MoveCandidate(
                    move=candidate.move,
                    resulting_board=candidate.resulting_board,
                    evaluation=evaluation,
                    equity=evaluation.equity,
                )
            )
        ranked.sort(key=lambda candidate: candidate.equity, reverse=True)
        return ranked

    monkeypatch.setattr(engine, "_native_rank_candidates", fake_native_rank_candidates)
    monkeypatch.setattr(engine, "_evaluate_with_rollout", fail_rollout)

    analysis = engine.rank_moves(board, dice, PlayerColor.WHITE, deduplicate_final_states=False)
    best_edges = tuple((m.from_point, m.to_point) for m in analysis.best_move.move.moves)
    assert best_edges == first_key
