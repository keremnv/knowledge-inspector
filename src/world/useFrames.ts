import { useEffect, useMemo, useRef, useState } from "react";
import { worldApi, type WorldRelation } from "../api/world";
import {
  ambientRelations,
  frameCandidates,
  frameView,
  type Ambient,
  type FramedView,
} from "./frame";
import { readFrameAnswers, writeFrameAnswers } from "./frameAnswers";
import type { WorkingSet } from "./workingSet";

/**
 * The field as drawn under framing, and the frames it found.
 *
 * Candidates are asked about once per revision: whether a referent takes part
 * in every tuple of a relation is a fact about the world, not about the field.
 * Answers are kept in the browser across visits — see `frameAnswers` — so a
 * framed field comes back framed instead of drawing unframed for the round
 * trip and snapping in. Off, or before any answer has arrived, the view is
 * the working set itself.
 */
export function useFrames(
  set: WorkingSet,
  relations: readonly WorldRelation[],
  revision: number | null,
  world: string | null,
  enabled: boolean,
  opened: ReadonlySet<string>,
): FramedView {
  const known = useRef(new Map<string, Set<string>>());
  const asked = useRef(new Set<string>());
  const [answered, setAnswered] = useState(0);
  /** Answers are about one revision; a late one from another is dropped. */
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    known.current = new Map();
    asked.current = new Set();
    if (world != null && revision != null) {
      /**
       * Seed from the last visit: answers are facts about this revision, so
       * a kept answer is this visit's answer, and the first frame below is
       * already the framed one. Seeded ids count as asked, or the effect
       * below refetches what it already holds.
       */
      for (const [id, names] of readFrameAnswers(world, revision)) {
        known.current.set(id, names);
        asked.current.add(id);
      }
    }
    setAnswered((count) => count + 1);
  }, [revision, world]);

  const candidates = useMemo(
    () => (enabled && relations.length ? frameCandidates(set) : []),
    [enabled, relations.length, set],
  );

  useEffect(() => {
    const asking = generation.current;
    for (const id of candidates) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      worldApi
        .referent(id)
        .then((detail) => {
          if (generation.current !== asking) return;
          known.current.set(id, ambientRelations(detail, relations));
          if (world != null && revision != null) {
            writeFrameAnswers(world, revision, known.current);
          }
          setAnswered((count) => count + 1);
        })
        .catch(() => {
          if (generation.current === asking) asked.current.delete(id);
        });
    }
  }, [candidates, relations, revision, world]);

  return useMemo(() => {
    if (!enabled) return { view: set, frames: [], reprojected: new Set<string>() };
    const ambient: Ambient = new Map(
      candidates
        .map((id) => [id, known.current.get(id)] as const)
        .filter((entry): entry is readonly [string, Set<string>] =>
          Boolean(entry[1]?.size),
        ),
    );
    return frameView(set, ambient, opened);
    // `answered` stands for the answers held in `known`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, candidates, enabled, opened, set]);
}
