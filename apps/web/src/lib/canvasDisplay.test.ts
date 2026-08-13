import { describe, expect, it } from "vitest";
import {
  CANVAS_DISPLAY_STORAGE_KEY,
  DEFAULT_CANVAS_DISPLAY,
  parseCanvasDisplay,
  serializeCanvasDisplay,
} from "./canvasDisplay";

describe("canvas display persistence (mib.canvasData)", () => {
  it("defaults to the data display (the founder ask: canvas shows live values)", () => {
    expect(DEFAULT_CANVAS_DISPLAY).toBe("data");
    expect(parseCanvasDisplay(null)).toBe("data");
  });

  it("round-trips both modes through serialize/parse", () => {
    expect(parseCanvasDisplay(serializeCanvasDisplay("data"))).toBe("data");
    expect(parseCanvasDisplay(serializeCanvasDisplay("variables"))).toBe("variables");
  });

  it("falls back to the default on unknown or corrupt stored values", () => {
    expect(parseCanvasDisplay('"resolved"')).toBe(DEFAULT_CANVAS_DISPLAY); // unknown mode
    expect(parseCanvasDisplay("{not json")).toBe(DEFAULT_CANVAS_DISPLAY); // corrupt JSON
    expect(parseCanvasDisplay('{"grid":true}')).toBe(DEFAULT_CANVAS_DISPLAY); // wrong shape
    expect(parseCanvasDisplay("")).toBe(DEFAULT_CANVAS_DISPLAY); // empty string
  });

  it("uses its own storage key, distinct from the snap settings' mib.snap", () => {
    expect(CANVAS_DISPLAY_STORAGE_KEY).toBe("mib.canvasData");
  });
});
