/**
 * Text shown as its characters, with the ones a reader cannot see made visible:
 * control characters (C0, DEL, C1), the line and paragraph separators, zero-width
 * characters and bidirectional controls are each shown as their escape (\n, \t,
 * \u200B…) and marked as an escape; every other character is shown as itself.
 * Quotes and backslashes are characters like any other: nothing is escaped that
 * a reader can already see.
 */
export type VisibleRun = { text: string; escape: boolean };

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const NAMED: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r" };

export function visibleRuns(text: string): VisibleRun[] {
  const runs: VisibleRun[] = [];
  let last = 0;
  for (const match of text.matchAll(INVISIBLE)) {
    if (match.index! > last) runs.push({ text: text.slice(last, match.index), escape: false });
    const ch = match[0];
    runs.push({ text: NAMED[ch] ?? `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`, escape: true });
    last = match.index! + ch.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), escape: false });
  return runs;
}
