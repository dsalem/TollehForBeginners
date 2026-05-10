from backend.app.domain import BoardState, PlayerColor, Point
from backend.app.engine import GnuBgEngine


def _set_point(
    board: BoardState, point_number: int, owner: PlayerColor, checker_count: int
) -> None:
    board.points[point_number - 1] = Point(owner=owner, checker_count=checker_count)


def test_initial_board_converts_to_expected_gnubg_rows_for_white() -> None:
    board = BoardState.initial()

    gnubg_board = GnuBgEngine.board_state_to_gnubg_board(
        board_state=board,
        player_color=PlayerColor.WHITE,
    )

    expected_row = [0] * 25
    expected_row[5] = 5
    expected_row[7] = 3
    expected_row[12] = 5
    expected_row[23] = 2

    assert gnubg_board[1] == expected_row
    assert gnubg_board[0] == expected_row


def test_conversion_handles_black_perspective_bar_and_borne_off_implicitly() -> None:
    board = BoardState.empty()
    _set_point(board, 4, PlayerColor.BLACK, 3)
    _set_point(board, 1, PlayerColor.BLACK, 2)
    _set_point(board, 20, PlayerColor.WHITE, 4)
    _set_point(board, 24, PlayerColor.WHITE, 1)
    board.bar_counts[PlayerColor.BLACK] = 2
    board.bar_counts[PlayerColor.WHITE] = 1
    board.borne_off_counts[PlayerColor.BLACK] = 8
    board.borne_off_counts[PlayerColor.WHITE] = 9

    gnubg_board = GnuBgEngine.board_state_to_gnubg_board(
        board_state=board,
        player_color=PlayerColor.BLACK,
    )
    opponent_row, player_row = gnubg_board

    # Player row is BLACK from BLACK perspective:
    # abs 4 -> perspective 21 -> idx 20
    # abs 1 -> perspective 24 -> idx 23
    assert player_row[20] == 3
    assert player_row[23] == 2
    assert player_row[24] == 2
    assert sum(player_row) == 15 - board.borne_off_counts[PlayerColor.BLACK]

    # Opponent row is WHITE from WHITE perspective.
    assert opponent_row[19] == 4
    assert opponent_row[23] == 1
    assert opponent_row[24] == 1
    assert sum(opponent_row) == 15 - board.borne_off_counts[PlayerColor.WHITE]

