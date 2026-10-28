import type { Graph } from "@antv/g6";

/** G6 assigns positive Tab order to every bitmap during canvas init.
 * These graphs configure pointer gestures, not keyboard graph navigation;
 * Finder, tables and reader own the keyboard equivalents. Subscribe before
 * render so no initialization frame exposes those unexplained stops.
 * Graph destruction also disposes this graph-owned listener.
 */
export function keepRendererOutOfTabOrder(graph: Graph) {
  graph.on("aftercanvasinit", () => {
    for (const layer of Object.values(graph.getCanvas().getLayers())) {
      const surface = layer.getContextService().getDomElement();
      if (surface instanceof HTMLElement) surface.tabIndex = -1;
    }
  });
}
