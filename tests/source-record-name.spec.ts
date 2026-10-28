import { test, expect } from "@playwright/test";
import { sourceKeyLabel, sourceRecordName } from "../src/source/sourceField";
import type { SourceCell } from "../src/api/source";

const int = (column: string, exact: string): SourceCell => ({ column, storage_class: "integer", exact });
const text = (column: string, exact: string): SourceCell => ({ column, storage_class: "text", exact });

test("O17 a record called by its key: Track 8; a TEXT key quoted; composite keys keep their column names", () => {
  expect(sourceKeyLabel("Track", [int("TrackId", "8")])).toBe("Track 8");
  expect(sourceKeyLabel("Genre", [text("Code", "Rock")])).toBe('Genre "Rock"');
  expect(sourceKeyLabel("PlaylistTrack", [int("PlaylistId", "1"), int("TrackId", "3402")])).toBe("PlaylistTrack PlaylistId=1; TrackId=3402");
  expect(sourceKeyLabel("Alpha", [int("id", "9007199254740993")])).toBe("Alpha 9007199254740993");
});

test("O17 a record named by its table's chosen column, exactly as recorded, or by its key", () => {
  const key = [int("TrackId", "8")];
  const cells = [...key, text("Name", "Evil Walks"), text("Composer", "  "), { column: "Bytes", storage_class: "null" } as SourceCell, int("Milliseconds", "263497")];
  expect(sourceRecordName("Track", key, cells, "Name")).toBe("Evil Walks");
  expect(sourceRecordName("Track", key, cells, "Milliseconds")).toBe("263497");
  // Empty, NULL, missing or no choice: the key label, never a guess.
  for (const column of ["Composer", "Bytes", "Nowhere", undefined]) expect(sourceRecordName("Track", key, cells, column)).toBe("Track 8");
  expect(sourceRecordName("Track", key, undefined, "Name")).toBe("Track 8");
});
