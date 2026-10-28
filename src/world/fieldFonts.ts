/**
 * Field text against the faces it is drawn in.
 *
 * A canvas measures and paints text with whatever face has loaded at that
 * moment. A name drawn while Jost is still on its way is drawn in the fallback
 * and stays drawn in it: a face arriving repaints nothing on a canvas. G also
 * keeps the first vertical metrics it measured for a font string, and plates
 * are sized and centred from measurements (`chipWidth`, `capitalCentring`).
 * So when the document finishes loading faces, every measurement is dropped
 * and the field is drawn again.
 */
import { useEffect, useState } from "react";
import { runtime } from "@antv/g";
import type { Graph } from "@antv/g6";
import { clearTextMeasures } from "./marks";

/**
 * A count that rises each time the document finishes loading faces. A field
 * that rebuilds its frame on it re-measures every plate.
 */
export function useFieldFontEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (!fonts) return;
    const settled = () => {
      clearTextMeasures();
      runtime.textService?.clearCache();
      setEpoch((count) => count + 1);
    };
    fonts.addEventListener("loadingdone", settled);
    return () => fonts.removeEventListener("loadingdone", settled);
  }, []);
  return epoch;
}

/**
 * Re-measure and repaint every name the renderer holds, in the faces now
 * loaded. Forced, because nothing about the text itself changed.
 */
export function refreshFieldText(graph: Graph) {
  if (graph.destroyed) return;
  for (const text of graph.getCanvas().document.getElementsByTagName("text")) {
    text.setAttribute("fontFamily", text.getAttribute("fontFamily"), true);
  }
}
