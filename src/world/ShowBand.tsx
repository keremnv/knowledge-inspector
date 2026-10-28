/**
 * The show filters, as one component rather than three copies.
 *
 * Collapsed it is one cell, `filter`. Hover or click opens the keys above it
 * — the same geometry the marks are drawn with, so the legend and the field
 * agree without either naming a colour. The keys must not join the instrument
 * row: that row is centred, and growing it would move the cell out from under
 * the pointer.
 */

import { useEffect, useRef, useState } from "react";
import { SHOW_LAYERS, type ShowLayer, type ShowState } from "./show";

/**
 * How long the menu waits after the pointer leaves before closing.
 *
 * The standard hover-intent grace period: the key row is a thin target, and
 * without it any overshoot above or below the keys — or a diagonal approach
 * that clips the corner — snaps the menu shut mid-pick. A quarter second is
 * inside the usual 200–500ms band: long enough to forgive travel, short
 * enough that a deliberate departure still reads as instant. Re-entering
 * cancels the close. Opening stays immediate.
 */
const SHOW_MENU_CLOSE_DELAY_MS = 250;

export type ShowBandProps = {
  show: ShowState;
  onShow: (next: (current: ShowState) => ShowState) => void;
  /**
   * Which layer controls to offer. Defaults to every layer; a world that
   * supplies no classification passes none, because a control for a
   * category the source never supplied would promote it into vocabulary.
   */
  layers?: ShowLayer[];
  /**
   * The names toggle, where the surface offers one.
   *
   * Omitted on a field that is already naming everything, because a control
   * that reports a state it cannot change is worse than no control.
   */
  names?: { on: boolean; onToggle: () => void };
  /**
   * The spread toggle, where the surface offers one.
   *
   * It sits with the filters because it is the same kind of control — a
   * statement about what the field draws, not about what the world says — and
   * it is omitted on a surface with no field for it to act on.
   */
  spread?: { on: boolean; onToggle: () => void };
  /**
   * Framing: referents present in every claim of a relation stop being drawn
   * as participants and become the frame those claims hold in — see `frame.ts`.
   */
  frame?: { on: boolean; onToggle: () => void };
};

export function ShowBand({ show, onShow, layers = SHOW_LAYERS, names, spread, frame }: ShowBandProps) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const suppressHover = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const open = pinned || hovered;

  useEffect(() => {
    if (!pinned) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setPinned(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [pinned]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  return (
    <div
      ref={rootRef}
      className={`world-filter${open ? " is-open" : ""}`}
      onMouseEnter={() => {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = undefined;
        if (suppressHover.current) return;
        setHovered(true);
      }}
      onMouseLeave={() => {
        suppressHover.current = false;
        window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(
          () => setHovered(false),
          SHOW_MENU_CLOSE_DELAY_MS,
        );
      }}
    >
      <div className="instrument__group">
        <button
          type="button"
          className="world-filter__summary"
          aria-expanded={open}
          aria-haspopup="true"
          onClick={() => {
            if (pinned) {
              setPinned(false);
              suppressHover.current = true;
              setHovered(false);
              return;
            }
            setPinned(true);
          }}
        >
          filter
        </button>
      </div>
      <div className="world-filter__menu">
        <div className="instrument__group" role="group" aria-label="Filter">
          {layers.map((layer) => (
            <button
              key={layer}
              type="button"
              className="world-show__filter"
              data-layer={layer}
              aria-pressed={show[layer]}
              title={layer === "unstated"
                ? `${show[layer] ? "Hide" : "Show"} BASE assertions with unstated construction origin`
                : `${show[layer] ? "Hide" : "Show"} ${layer} assertions`}
              onClick={() =>
                onShow((current) => ({ ...current, [layer]: !current[layer] }))
              }
            >
              <span className="world-show__key" aria-hidden="true" />
              <span className="world-show__name">{layer}</span>
            </button>
          ))}
          {names ? (
            <button
              type="button"
              className="world-show__filter"
              data-layer="names"
              aria-pressed={names.on}
              title={names.on ? "Show names on focus only" : "Keep names visible"}
              onClick={names.onToggle}
            >
              <span className="world-show__key" aria-hidden="true" />
              <span className="world-show__name">names</span>
            </button>
          ) : null}
          {spread ? (
            <button
              type="button"
              className="world-show__filter"
              data-layer="spread"
              aria-pressed={spread.on}
              title={
                spread.on
                  ? "Keep a selected mark's filaments straight, names stacked"
                  : "Spread a selected mark's filaments so their names clear"
              }
              onClick={spread.onToggle}
            >
              <span className="world-show__key" aria-hidden="true" />
              <span className="world-show__name">spread</span>
            </button>
          ) : null}
          {frame ? (
            <button
              type="button"
              className="world-show__filter"
              data-layer="frame"
              aria-pressed={frame.on}
              title={
                frame.on
                  ? "Draw every referent as a participant"
                  : "Draw referents present in every claim of a relation as its frame"
              }
              onClick={frame.onToggle}
            >
              <span className="world-show__key" aria-hidden="true" />
              <span className="world-show__name">frame</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
