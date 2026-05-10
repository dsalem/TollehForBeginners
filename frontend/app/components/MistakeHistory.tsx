"use client";

import { useState } from "react";

type MoveQualityClass = "GOOD" | "INACCURACY" | "ERROR" | "BLUNDER";

export type MistakeHistoryEntry = {
  index: number;
  player: "WHITE" | "BLACK";
  moveLabel: string;
  classification: MoveQualityClass;
  equityLoss: number;
  timestamp: string;
};

type Props = {
  entries: MistakeHistoryEntry[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
};

const tierClass: Record<Exclude<MoveQualityClass, "GOOD">, string> = {
  INACCURACY: "slight",
  ERROR: "error",
  BLUNDER: "blunder",
};

const tierLabel: Record<Exclude<MoveQualityClass, "GOOD">, string> = {
  INACCURACY: "Slight",
  ERROR: "Error",
  BLUNDER: "Blunder",
};

export default function MistakeHistory({ entries, selectedIndex, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const mistakes = entries.filter((e) => e.classification !== "GOOD");

  return (
    <section className="mistake-history-panel section-review">
      <button
        type="button"
        className="mistake-history-head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <strong>Mistakes ({mistakes.length})</strong>
        <span className="mistake-history-toggle">{collapsed ? "+" : "−"}</span>
      </button>
      {!collapsed ? (
        mistakes.length === 0 ? (
          <p className="mistake-history-empty">No mistakes yet — keep it up.</p>
        ) : (
          <div className="mistake-history-list">
            {mistakes.map((entry) => {
              const cls = tierClass[entry.classification as Exclude<MoveQualityClass, "GOOD">];
              const isSelected = selectedIndex === entry.index;
              return (
                <button
                  type="button"
                  key={`${entry.timestamp}-${entry.index}`}
                  className={`mistake-history-item ${cls} ${isSelected ? "is-selected" : ""}`}
                  onClick={() => onSelect(entry.index)}
                  title="Replay best move on board"
                >
                  <span className="sev" aria-hidden />
                  <span className="label">
                    <span className="player">{entry.player}</span>
                    <span className="move">{entry.moveLabel}</span>
                  </span>
                  <span className="eq">
                    {tierLabel[entry.classification as Exclude<MoveQualityClass, "GOOD">]}
                    <span className="loss">−{Math.abs(entry.equityLoss).toFixed(3)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )
      ) : null}
    </section>
  );
}
