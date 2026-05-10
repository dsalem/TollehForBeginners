from backend.app.domain import BoardState, DiceRoll, PlayerColor, Point


def _apply_turn_move(board: BoardState, turn_index: int, turns: list) -> BoardState:
    updated = board.copy()
    for move in turns[turn_index].moves:
        updated.apply_single_checker_move(move)
    return updated


def test_uses_both_dice_when_both_can_be_played() -> None:
    board = BoardState.initial()

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(1, 2))

    assert turns
    assert all(len(turn.moves) == 2 for turn in turns)


def test_tries_both_dice_orders_for_non_doubles() -> None:
    board = BoardState.empty()
    board.points[5] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 6
    board.points[3] = Point(owner=PlayerColor.BLACK, checker_count=2)  # point 4 blocked

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(2, 1))

    assert len(turns) == 1
    assert len(turns[0].moves) == 2
    assert turns[0].moves[0].from_point == 6
    assert turns[0].moves[0].to_point == 5
    assert turns[0].moves[1].from_point == 5
    assert turns[0].moves[1].to_point == 3


def test_higher_die_is_forced_when_only_one_die_can_be_played() -> None:
    board = BoardState.empty()
    board.bar_counts[PlayerColor.WHITE] = 1
    board.points[13] = Point(owner=PlayerColor.BLACK, checker_count=2)  # point 14 blocked

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(6, 5))

    assert len(turns) == 1
    assert len(turns[0].moves) == 1
    assert turns[0].moves[0].from_bar is True
    assert turns[0].moves[0].to_point == 19


def test_doubles_generate_four_moves_when_all_are_playable() -> None:
    board = BoardState.empty()
    board.points[7] = Point(owner=PlayerColor.WHITE, checker_count=4)  # point 8

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(1, 1))

    assert turns
    assert all(len(turn.moves) == 4 for turn in turns)


def test_generation_handles_hitting_blot() -> None:
    board = BoardState.empty()
    board.points[9] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 10
    board.points[7] = Point(owner=PlayerColor.BLACK, checker_count=1)  # point 8 blot

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(2, 1))

    assert turns
    final_boards = [_apply_turn_move(board, index, turns) for index in range(len(turns))]
    assert any(final.bar_counts[PlayerColor.BLACK] == 1 for final in final_boards)


def test_generation_forces_bar_entry_before_other_moves() -> None:
    board = BoardState.initial()
    board.bar_counts[PlayerColor.WHITE] = 1

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(1, 2))

    assert turns
    assert all(turn.moves[0].from_bar for turn in turns)


def test_bearing_off_and_duplicate_final_moves_are_handled() -> None:
    board = BoardState.empty()
    board.points[5] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 6
    board.points[0] = Point(owner=PlayerColor.WHITE, checker_count=1)  # point 1
    board.points[4] = Point(owner=PlayerColor.BLACK, checker_count=2)  # point 5 blocked

    turns = board.generate_legal_turn_moves(PlayerColor.WHITE, DiceRoll(6, 1))

    assert len(turns) == 1
    assert len(turns[0].moves) == 2
    assert all(move.to_borne_off for move in turns[0].moves)

    final_board = _apply_turn_move(board, 0, turns)
    assert final_board.borne_off_counts[PlayerColor.WHITE] == 2
    assert final_board.get_point(6).checker_count == 0
    assert final_board.get_point(1).checker_count == 0
