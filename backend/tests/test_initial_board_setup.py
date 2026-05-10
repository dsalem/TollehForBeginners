from backend.app.domain import BoardState, PlayerColor


def test_initial_board_has_24_points() -> None:
    board = BoardState.initial()
    assert len(board.points) == 24


def test_initial_board_uses_standard_checker_placement() -> None:
    board = BoardState.initial()

    expected = {
        24: (PlayerColor.WHITE, 2),
        13: (PlayerColor.WHITE, 5),
        8: (PlayerColor.WHITE, 3),
        6: (PlayerColor.WHITE, 5),
        1: (PlayerColor.BLACK, 2),
        12: (PlayerColor.BLACK, 5),
        17: (PlayerColor.BLACK, 3),
        19: (PlayerColor.BLACK, 5),
    }

    for point_number, (owner, checker_count) in expected.items():
        point = board.get_point(point_number)
        assert point.owner == owner
        assert point.checker_count == checker_count


def test_initial_board_has_empty_non_starting_points() -> None:
    board = BoardState.initial()
    occupied = {1, 6, 8, 12, 13, 17, 19, 24}

    for point_number in range(1, 25):
        if point_number in occupied:
            continue

        point = board.get_point(point_number)
        assert point.owner is None
        assert point.checker_count == 0


def test_initial_board_tracks_bar_and_borne_off_separately() -> None:
    board = BoardState.initial()

    assert board.bar_counts[PlayerColor.WHITE] == 0
    assert board.bar_counts[PlayerColor.BLACK] == 0
    assert board.borne_off_counts[PlayerColor.WHITE] == 0
    assert board.borne_off_counts[PlayerColor.BLACK] == 0


def test_initial_board_has_15_checkers_per_player() -> None:
    board = BoardState.initial()

    white_total = sum(
        point.checker_count for point in board.points if point.owner == PlayerColor.WHITE
    )
    black_total = sum(
        point.checker_count for point in board.points if point.owner == PlayerColor.BLACK
    )

    assert white_total == 15
    assert black_total == 15
