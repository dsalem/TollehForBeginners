"use client";

/**
 * Full-screen overlay shown on phone-sized screens held in portrait.
 * The Pixi board is 16:9 and there's no usable layout for portrait,
 * so we ask the user to rotate before they try to play.
 *
 * Visibility is controlled by CSS media queries — the component is
 * always mounted but `display: none` outside the portrait+narrow case.
 */
export default function RotatePrompt() {
  return (
    <div className="rotate-prompt" role="dialog" aria-label="Rotate device">
      <div className="rotate-prompt-card">
        <div className="rotate-prompt-icon" aria-hidden>
          ⟳
        </div>
        <div className="rotate-prompt-title">Rotate your phone</div>
        <div className="rotate-prompt-body">
          Tolleh is designed for landscape. Turn your phone sideways to play.
        </div>
      </div>
    </div>
  );
}
