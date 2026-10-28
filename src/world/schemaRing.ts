/**
 * Where a schema's discs stand: World's ring, on its own so a caller can take
 * it without the renderer (`schemaGraph` imports G6). Moved here unchanged
 * from `schemaGraph.ts`; the Source schema view stands its tables on it (O12).
 */
type Point = { x: number; y: number };

const RING_MIN = 260;
const RING_PER_KIND = 42;
/** Ring radius when there are too few kinds for a ring. Two discs 300 apart
 * leave 210px of rim-to-rim room — enough for the pair chips and filaments
 * between them — while keeping the axis short enough that the fans beside it
 * read as branches rather than as poles. See `ringPositions`. */
const RING_SMALL = 150;

export function ringPositions(kinds: string[]): Map<string, Point> {
  // One or two kinds are not a ring but an axis, and an axis belongs along
  // the landscape: a vertical two-kind axis with its fans stacked above and
  // below measured 0.41 in a 1.25 frame, height-bound and a third smaller
  // than the frame allows. So the degenerate ring starts at nine o'clock —
  // first kind leftmost, reading order — on a shorter radius, and only a
  // true ring starts at twelve.
  const small = kinds.length <= 2;
  const radius = small
    ? RING_SMALL
    : Math.max(RING_MIN, RING_PER_KIND * kinds.length);
  const start = small ? Math.PI : -Math.PI / 2;
  return new Map(
    kinds.map((kind, index) => {
      // The ring is a thing to learn, not to re-read: the first kind
      // alphabetically is always in the same place for a given ring size.
      const angle = start + (index * Math.PI * 2) / kinds.length;
      return [
        kind,
        { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) },
      ];
    }),
  );
}
