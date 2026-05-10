# Tolleh Backgammon — Redesign Plan

**Scope:** Frontend rewrite (page.tsx + BackgammonPixiBoard.tsx + globals.css), with one or two small optional backend additions. The gnubg engine, move generator, match-play proxy, doubling-cube logic, opening book, and `/games/{id}/move` response shape stay as they are.

**Visual direction:** Classic wood-and-felt board, like a tournament-quality NextGammon table. Warm, traditional, dimensional — not flat or "app-y."

**Mistake feedback:** Inline card that animates in next to the board the moment a sub-optimal move is committed, showing severity, equity loss, the best move (with an arrow overlay on the board), and a one-click "replay best."

---

## 1. Visual direction

The current board uses procedural Pixi vectors with literal hex colors strewn across the draw functions. We replace it with a themed, asset-backed look:

- **Frame**: warm walnut wood with mitred corners and a subtle inner bevel. Two parallel inlay strokes around the playing surface (gold-lacquer feel).
- **Felt**: aged cream/parchment field, lightly noised, with a soft inner shadow at the rail to imply depth.
- **Triangles**: alternating burgundy (#7a2e23) and bone (#e9d8b6) with a tiny stitched edge at the base, slightly rounded tips so they don't look like CSS clip-paths.
- **Bar**: matching walnut, with a subtle vertical grain.
- **Checkers**: domed disks with a specular highlight, an inner ring (tournament-style "pip"), and a soft drop shadow so stacks look stacked. Ivory and ebony.
- **Dice**: ivory cubes with rounded corners, deep-red pips, gentle shadow under the resting cube, very small randomized rotation so they never look digitally perfect.
- **Doubling cube**: matching ivory, slightly larger numerals, sits in the cube tray (left rail). Glows when an offer is pending.
- **Type**: a mature serif for numbers/equities ("Source Serif" or "EB Garamond"), modern sans for action labels ("Inter").

We keep **PixiJS** for the board itself (it's already wired, fast, and supports the highlight/animation overlays we need), but introduce a `theme.ts` module so every color/gradient/stroke is named and centralized. Goal: zero hardcoded color literals in `BackgammonPixiBoard.tsx`.

## 2. Component architecture

Page-level shell becomes a three-column responsive layout:

```
┌──────────────────────────────────────────────────────────────┐
│  TopBar: match score, cube state, turn indicator, menu        │
├─────────────────┬──────────────────────────┬─────────────────┤
│                 │                          │                 │
│  LeftRail       │     BoardStage           │   RightRail     │
│  - cube tray    │     (PixiJS canvas)      │   - move log    │
│  - pip count    │                          │   - mistake     │
│  - score        │                          │     history     │
│                 │                          │                 │
└─────────────────┴──────────────────────────┴─────────────────┘
                ↑ MistakeCard floats over BoardStage,
                  anchored to right-bottom of board
```

New/refactored components:

- `<BoardStage />` — Pixi host. Owns hit detection, drag state, dice/cube widgets, and an **overlay layer** where we draw arrows for "best move" replay.
- `<MistakeCard />` — animated floating card. Anchored to the board's bottom-right corner. Three severity skins.
- `<MistakeHistory />` — collapsible list of mistakes for the current game; clicking an entry replays its arrows on the board.
- `<TopBar />`, `<LeftRail />`, `<RightRail />` — straightforward layout components.
- `theme.ts` — exports `palette`, `radii`, `shadows`, `motion` (durations + easings).
- `useGame()` — small custom hook that wraps the existing fetch/WebSocket pair so `page.tsx` stops being 2,500 lines.

The PixiJS board internally gets split into `drawFrame`, `drawFelt`, `drawPoints`, `drawBar`, `drawCheckers`, `drawDice`, `drawCube`, `drawHighlights`, `drawArrows` — each takes the theme and a state slice.

## 3. Tokens

```ts
// theme.ts (excerpt)
export const palette = {
  woodDark:   '#3b2412',
  woodMid:    '#5c3a20',
  woodLight:  '#8a5a32',
  woodInlay:  '#c79a4a',
  felt:       '#efe2c6',
  feltShade:  '#d8c69e',
  pointDark:  '#7a2e23',
  pointLight: '#e9d8b6',
  ivory:      '#f5ecd6',
  ebony:      '#1a1410',
  diceFace:   '#f8efd8',
  dicePip:    '#7a1a14',
  // semantic
  good:       '#3c8a4a', // equity loss < 0.02
  slight:     '#c9a23a', // < 0.05  (INACCURACY)
  error:      '#d97a1f', // < 0.10  (ERROR)
  blunder:    '#b21d1d', // ≥ 0.10  (BLUNDER)
};

export const motion = {
  cardEnterMs:  220,
  cardEnterEase:'cubic-bezier(.2,.8,.2,1)',
  arrowDrawMs:  450,
};
```

## 4. Inline mistake card — spec

**Anchor:** floats over the board's bottom-right corner with a 16px gutter from the rail. On narrow screens collapses to a full-width banner above the board.

**Trigger:** appears if `post_move_analysis.classification !== 'GOOD'`. (For GOOD moves, a tiny green check pulses on the played checker for 600 ms — no card.)

**Anatomy (top to bottom):**

1. **Severity badge.** Pill with the severity color from the palette and one of: "Slight slip" (INACCURACY), "Error", "Blunder". The four-tier semantic palette (`good/slight/error/blunder`) drives every accent on the card.
2. **Equity-loss number.** Big (28pt) serif numeral, e.g. `−0.082`. Tiny "equity" label underneath.
3. **Comparison row.** Two stacked lines:
   - "Your move: 13/8 24/23 — eq −0.310"
   - "Best move: 13/11 24/23 — eq −0.228"
   The best line is the highlight color of the severity badge.
4. **Arrow overlay toggle.** Button "Show best on board". Default: on. Clicking re-draws the arrow path (two arrows for two sub-moves) on the board overlay.
5. **Action row.**
   - "Replay best" — animates checkers along the best path, then snaps back to actual position so user can resume play.
   - "Dismiss" — fades card out.
6. **Footer line.** Small, dim text: ranking method + rollout flag, e.g. `1-ply • rollout (124 pos.) • opening book`. Only shows fields that are meaningful.

**Severity-tier styling:**

| Tier        | Threshold       | Card border  | Badge bg    | Tone         |
|-------------|-----------------|--------------|-------------|--------------|
| Slight slip | ≤ 0.05          | 1px slight   | slight      | informational|
| Error       | ≤ 0.10          | 2px error    | error       | corrective   |
| Blunder     | > 0.10          | 2px blunder  | blunder     | emphatic; subtle 2-frame shake on enter |

**Animation:**
- Card slides up 8px and fades in over 220ms (`motion.cardEnterMs`).
- Best-move arrows draw in sequence: arrow 1 over 220ms, arrow 2 over 220ms after a 100ms gap.
- "Replay best" animates checkers along the path with the existing checker-move tween (450ms each).
- On dismiss, card fades out and the analysis is appended to `<MistakeHistory />`.

**Keyboard:**
- `Esc` dismiss
- `B` toggle best-move overlay
- `R` replay best

**Accessibility:**
- Card is `role="status" aria-live="polite"`, so screen readers announce severity + equity loss + best move.
- Severity color is never the sole signal: each tier has its own icon (✓ slight slip / ⚠ error / 🛑 blunder rendered as inline SVG, not emoji).

## 5. Animation principles

- **One easing curve everywhere** for UI: `cubic-bezier(.2,.8,.2,1)`.
- **Pixi tweens for board elements** (checkers, dice, cube), DOM transitions for cards/panels.
- **Never block input** — animations always interruptible. If the user starts a new move, the card fades out cleanly.
- **Subtle, not flashy** — checker placement gets 220ms ease, no bouncing, no particles.

## 6. Implementation phases

1. **Theme extraction.** Add `theme.ts`. Replace every color literal in `BackgammonPixiBoard.tsx`. No visual change yet — just plumbing. (~half day.)
2. **Board re-skin.** New felt + frame + point + checker + dice draws using palette tokens and the gradient/shadow treatments described above. (~1 day.)
3. **Layout shell.** Split `page.tsx` into `TopBar`, `LeftRail`, `RightRail`, `BoardStage`, `useGame()`. No behavior changes. (~1 day.)
4. **MistakeCard component.** Build the floating card driven by `post_move_analysis`. Three severity skins. Arrow overlay drawn on a Pixi overlay layer. (~1 day.)
5. **MistakeHistory.** Collapsible list with click-to-replay. (~half day.)
6. **Polish.** Reduced-motion media query, mobile breakpoint (banner mode), keyboard shortcuts, `aria-live`. (~half day.)
7. **Cleanup.** Delete the old `.analysis-panel` block in page.tsx; sweep for dead CSS. (~2 hours.)

Total: ~5 working days for one engineer.

## 7. Optional backend additions

Neither blocks v1, but both are small and improve the card.

- **Pip counts** in `GameStateResponse` (`pip_white: int, pip_black: int`). The card can then show "you now trail by 12 pips after this move." Five-line change in `_serialize_game_state()`.
- **Severity copy** in `PostMoveAnalysisResponse` (`severity_label: str` and `severity_caption: str`). Centralizes wording so iOS/web stay consistent if a native client is ever built. Otherwise frontend derives from `classification`.

## 8. Risks

- **Pixi hit detection.** Click handlers are attached to the geometry objects we redraw. The redraw must re-bind hit zones to the same point indices, or we break input. Mitigation: extract a `Point` class that owns its draw + hit zone together.
- **Scrollbar / horizontal real estate.** The floating card overlaps the right rail at narrower widths. Below 1100px we collapse the right rail, below 760px we switch to the banner-above-board layout.
- **WebSocket ↔ post-move state drift.** Today both `setGame()` and `setPostMoveFeedback()` race. The card key should be `move_id` (or `turn_number + ply`) so a stale WS message doesn't redisplay a card the user already dismissed.
- **Engine latency.** A blunder during a slow rollout still won't show the card for several seconds. We add a small "analyzing…" pip on the played checker so users know feedback is coming, and we surface the rollout flag in the card footer when it does land.
- **Pixi StrictMode remount.** Existing teardown is fragile. Re-bind dispose sequence so Application is never destroyed twice; handle the dev-mode double-mount explicitly.

---

**Next step after sign-off:** Phase 1 (theme extraction) — purely mechanical, zero risk. Then Phase 2 (re-skin) for visual review. After that, MistakeCard.
