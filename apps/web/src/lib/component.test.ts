/**
 * Series JSON validation (§7.6): the Studio edits a series default as a JSON
 * textarea; parseSeriesJson is the gate every commit passes — array-only,
 * schema-capped at 1024 items, with author-readable errors.
 */
import { describe, expect, it } from "vitest";
import {
  SERIES_MAX_ITEMS,
  isCodeDefinition,
  parseSeriesJson,
} from "./component";

describe("parseSeriesJson", () => {
  it("accepts arrays of arbitrary JSON elements", () => {
    const cases: [string, unknown[]][] = [
      ["[]", []],
      ["[0, 3, 7]", [0, 3, 7]],
      [
        '[{"date":"2026-01-01","count":4}]',
        [{ date: "2026-01-01", count: 4 }],
      ],
      ['[1, "two", null, {"x":[]}]', [1, "two", null, { x: [] }]],
      ["  [1,\n 2]  ", [1, 2]],
    ];
    for (const [text, want] of cases) {
      const res = parseSeriesJson(text);
      expect(res.ok, text).toBe(true);
      if (res.ok) expect(res.value).toEqual(want);
    }
  });

  it("rejects malformed JSON with the parser's message", () => {
    const res = parseSeriesJson("[1, 2");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
  });

  it("rejects valid JSON that is not an array, naming the actual type", () => {
    for (const [text, type] of [
      ['{"a":1}', "object"],
      ['"calendar"', "string"],
      ["42", "number"],
      ["null", "null"],
      ["true", "boolean"],
    ] as const) {
      const res = parseSeriesJson(text);
      expect(res.ok, text).toBe(false);
      if (!res.ok) expect(res.error).toContain(type);
    }
  });

  it("enforces the schema's 1024-item cap exactly", () => {
    const atCap = `[${Array(SERIES_MAX_ITEMS).fill(0).join(",")}]`;
    expect(parseSeriesJson(atCap).ok).toBe(true);

    const overCap = `[${Array(SERIES_MAX_ITEMS + 1).fill(0).join(",")}]`;
    const res = parseSeriesJson(overCap);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(String(SERIES_MAX_ITEMS));
  });
});

describe("isCodeDefinition", () => {
  it("is true exactly for kind code", () => {
    expect(isCodeDefinition({ kind: "code" })).toBe(true);
    expect(isCodeDefinition({ kind: "declarative" })).toBe(false);
    expect(isCodeDefinition({})).toBe(false);
  });
});
