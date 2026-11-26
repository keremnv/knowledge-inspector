import { test, expect } from "@playwright/test";
import { parseSourceJson, sourceJson, sourceJsonSize, SOURCE_JSON_MAX_DEPTH } from "../src/source/sourceJsonReading";
import { visibleRuns } from "../src/source/sourceVisibleText";

test("numbers keep their lexeme: no rounding, no normalising", () => {
  const read = parseSourceJson('{"big": 12345678901234567890, "money": 1.10, "huge": 1e400, "neg": -0, "e": 2E-3}');
  expect(read).toEqual({ kind: "object", members: [
    { key: "big", value: { kind: "number", lexeme: "12345678901234567890" }, repeated: false },
    { key: "money", value: { kind: "number", lexeme: "1.10" }, repeated: false },
    { key: "huge", value: { kind: "number", lexeme: "1e400" }, repeated: false },
    { key: "neg", value: { kind: "number", lexeme: "-0" }, repeated: false },
    { key: "e", value: { kind: "number", lexeme: "2E-3" }, repeated: false },
  ] });
});

test("members stay in recorded order and a repeated key is kept and marked", () => {
  const read = parseSourceJson('{"b": 1, "a": 2, "b": 3}');
  expect(read).toEqual({ kind: "object", members: [
    { key: "b", value: { kind: "number", lexeme: "1" }, repeated: false },
    { key: "a", value: { kind: "number", lexeme: "2" }, repeated: false },
    { key: "b", value: { kind: "number", lexeme: "3" }, repeated: true },
  ] });
});

test("strings are their decoded value; literals and arrays as written", () => {
  expect(parseSourceJson('  ["\\u00e9\\n", true, false, null, [], {}]\n')).toEqual({ kind: "array", items: [
    { kind: "string", value: "é\n" }, { kind: "literal", lexeme: "true" }, { kind: "literal", lexeme: "false" },
    { kind: "literal", lexeme: "null" }, { kind: "array", items: [] }, { kind: "object", members: [] },
  ] });
});

test("only an object or an array is read as JSON; a scalar TEXT stays TEXT", () => {
  for (const text of ["5", '"x"', "true", "null", "", "   ", "hello", "-1"]) expect(parseSourceJson(text)).toBeNull();
});

test("anything but exactly one strict JSON document stays TEXT", () => {
  for (const text of ['{"a": 1,}', '[1, 2,]', '{"a": 1 /* c */}', '// c\n{"a": 1}', '{} x', '{"a": 1}{"b": 2}',
    '{"a": 1', "{a: 1}", "{'a': 1}", '[01]', '[NaN]', '{"a" 1}']) {
    expect(parseSourceJson(text), text).toBeNull();
  }
});

test("nesting deeper than the limit stays TEXT, and nesting deep enough to overflow the parser does not throw", () => {
  const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
  expect(parseSourceJson(nest(SOURCE_JSON_MAX_DEPTH))).not.toBeNull();
  expect(parseSourceJson(nest(SOURCE_JSON_MAX_DEPTH + 2))).toBeNull();
  expect(parseSourceJson(nest(200_000))).toBeNull();
});

test("the cached reading is the same reading", () => {
  const text = '{"id": "judgment:x", "outcome": "met"}';
  expect(sourceJson(text)).toEqual(parseSourceJson(text));
  expect(sourceJson(text)).toBe(sourceJson(text));
  expect(sourceJson("plain")).toBeNull();
});

test("sizes are said as the collapsed line says them", () => {
  expect(sourceJsonSize(parseSourceJson('{"a": 1}')!)).toBe("1 key");
  expect(sourceJsonSize(parseSourceJson('{"a": 1, "b": 2}')!)).toBe("2 keys");
  expect(sourceJsonSize(parseSourceJson("[1]")!)).toBe("1 item");
  expect(sourceJsonSize(parseSourceJson("[1, 2, 3]")!)).toBe("3 items");
});

test("visible text: characters as themselves, invisible ones as marked escapes", () => {
  expect(visibleRuns('sex == "male" and \\ x')).toEqual([{ text: 'sex == "male" and \\ x', escape: false }]);
  expect(visibleRuns("a\nb\tc")).toEqual([{ text: "a", escape: false }, { text: "\\n", escape: true }, { text: "b", escape: false },
    { text: "\\t", escape: true }, { text: "c", escape: false }]);
  expect(visibleRuns("\u0000\u200b\u202e\ufeff")).toEqual(["\\u0000", "\\u200B", "\\u202E", "\\uFEFF"].map((text) => ({ text, escape: true })));
  expect(visibleRuns("")).toEqual([]);
  expect(visibleRuns("é ü 日本")).toEqual([{ text: "é ü 日本", escape: false }]);
});
