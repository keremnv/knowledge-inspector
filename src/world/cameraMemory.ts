/**
 * A room's camera, remembered between visits — in this browser, for this world.
 *
 * Zoom plus the canvas point at the viewport centre — the pair
 * `getZoom`/`getViewportCenter` reads. Restore zooms, then pans that point
 * back under the centre the way `panToElement` already pans a mark under its
 * target, instant and without a flight. Display state only, like the
 * arrangement stores: it says nothing about the world.
 *
 * A centre, not a pixel offset, so a window resized between visits still
 * frames the same content. (`translateTo` is not the inverse of
 * `getPosition` — measured, it lands elsewhere — so the stored pair is not
 * zoom-plus-translate.)
 *
 * Keyed by room, world **and revision**. A camera frames an arrangement, and
 * arrangements are revision-scoped — a rebuild re-lays-out, and a camera kept
 * for the old layout would frame empty space.
 *
 * Only settled, person-moved cameras are kept. Every transform — wheel, drag,
 * fit, flight — reports through `aftertransform`, so capture debounces to the
 * settled camera, and programmatic moves hold the recorder while they run: a
 * focus flight ends at a mark the next visit will not have selected, and
 * storing that endpoint would spend the person's framing on transient
 * attention.
 */

import type { Graph } from "@antv/g6";

export type CameraRoom = "field" | "schema";
/** World keeps local storage by default; Source explicitly chooses tab storage. */
export type CameraStorage = "localStorage" | "sessionStorage";

/** Zoom plus the canvas point at the viewport centre. */
export type StoredCamera = {
  zoom: number;
  cx: number;
  cy: number;
};

const STORAGE_PREFIX = "worldir.camera";
/** A camera counts as left when nothing has moved it for this long. */
const SETTLE_MS = 300;

function keyOf(room: CameraRoom, world: string, revision: number): string {
  return `${STORAGE_PREFIX}:${room}:${world}:${revision}`;
}

function valid(cam: Partial<StoredCamera> | null | undefined): cam is StoredCamera {
  return (
    !!cam &&
    typeof cam.zoom === "number" &&
    cam.zoom > 0 &&
    Number.isFinite(cam.zoom) &&
    Number.isFinite(cam.cx) &&
    Number.isFinite(cam.cy)
  );
}

/** Put a room's camera away. */
export function writeCamera(
  room: CameraRoom,
  world: string,
  revision: number,
  cam: StoredCamera,
  storage: CameraStorage = "localStorage",
): void {
  try {
    window[storage].setItem(
      keyOf(room, world, revision),
      JSON.stringify({ version: 1, world, revision, ...cam }),
    );
  } catch {
    // Same as the arrangement stores: private mode or quota means the camera
    // lives in the tab only.
  }
}

/** Take a room's camera back out, or nothing. */
export function readCamera(
  room: CameraRoom,
  world: string,
  revision: number,
  storage: CameraStorage = "localStorage",
): StoredCamera | null {
  try {
    const raw = window[storage].getItem(keyOf(room, world, revision));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredCamera> & {
      version?: number;
      world?: string;
      revision?: number;
    };
    if (
      stored.version !== 1 ||
      stored.world !== world ||
      stored.revision !== revision ||
      !valid(stored)
    ) {
      return null;
    }
    return { zoom: stored.zoom, cx: stored.cx, cy: stored.cy };
  } catch {
    return null;
  }
}

export type CameraRecorder = {
  /**
   * Suppress capture across a programmatic move. Async-safe: the hold lasts
   * until the returned release runs, so it spans an awaited flight.
   */
  hold: () => () => void;
  /** Offer the settled camera to the store. Skipped while held. */
  capture: (graph: Graph) => void;
  /**
   * Apply the stored camera, once per recorder. True when a camera was
   * applied and the caller owes no establish move; false when there was
   * nothing stored and the caller frames as it always did.
   */
  restore: (graph: Graph) => Promise<boolean>;
  dispose: () => void;
};

/** A room's camera, kept level with the store. */
export function createCameraRecorder(
  room: CameraRoom,
  world: string,
  revision: number,
  storage: CameraStorage = "localStorage",
): CameraRecorder {
  let timer: number | null = null;
  let held = 0;
  let restored = false;
  const recorder: CameraRecorder = {
    hold() {
      held += 1;
      return () => {
        held = Math.max(0, held - 1);
      };
    },
    capture(graph: Graph) {
      if (held > 0) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (held > 0 || graph.destroyed) return;
        const centre = graph.getViewportCenter();
        const cam = { zoom: graph.getZoom(), cx: centre[0], cy: centre[1] };
        if (!valid(cam)) return;
        writeCamera(room, world, revision, cam, storage);
      }, SETTLE_MS);
    },
    async restore(graph: Graph): Promise<boolean> {
      if (restored) return true;
      restored = true;
      const cam = readCamera(room, world, revision, storage);
      if (!cam || graph.destroyed) return false;
      // Zoom first, then pan the stored centre back under the viewport
      // centre — the same two-step `panToElement` uses. Instant: a restore is
      // establishment, not a flight.
      const release = recorder.hold();
      try {
        await graph.zoomTo(cam.zoom, { duration: 0 });
        if (graph.destroyed) return false;
        const [width, height] = graph.getSize();
        const at = graph.getViewportByCanvas([cam.cx, cam.cy]);
        await graph.translateBy([width / 2 - at[0], height / 2 - at[1]], {
          duration: 0,
        });
      } finally {
        release();
      }
      return true;
    },
    dispose() {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
    },
  };
  return recorder;
}
