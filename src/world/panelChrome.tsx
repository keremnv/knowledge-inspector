import type { MouseEvent } from "react";
import "./panelChrome.css";

/**
 * Chrome a panel has because it is a panel, not because of what is in it.
 *
 * There was one control here and it was drawn twice. The reader's said
 * `Close`, bare, 24x19, sentence case. The tables dock's said `close`, in a
 * bordered chip, 41x21. Same act, same panel component underneath, same font
 * size and colour — and every other property different, including the
 * capital. Two people writing the same button at different times is exactly
 * the drift this file exists to end, and it is the more corrosive kind:
 * nothing is broken, so nothing ever gets fixed.
 *
 * The chip won. Lowercase and bordered is what the rest of the product's
 * controls look like — `world` and `frontier` beside it in the table bar,
 * `semantic`, `derived`, `remove`, `vocabulary` in the instrument band. The
 * reader's bare `Close` was the outlier, and its sentence case belonged to
 * the reader's *content* actions ("Open on the field", "Why this tuple"),
 * which are a different kind of thing: those act on the tuple, this one
 * closes the panel it is drawn in.
 */

export function PanelClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="panel__close" onClick={onClose}>
      close
    </button>
  );
}

/**
 * The way back down the reader's trail, beside the way out of it.
 *
 * The same chip as `PanelClose`, because it is the same kind of thing: panel
 * chrome, not a content action. It sits left of close — back first, out last —
 * and only while there is somewhere back to go.
 */
export function PanelBack({ onBack, label = "Back" }: { onBack: (event: MouseEvent<HTMLButtonElement>) => void; label?: string }) {
  return (
    <button type="button" className="panel__back" onClick={onBack} aria-label={label}>
      back
    </button>
  );
}
