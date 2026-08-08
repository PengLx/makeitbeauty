import { describe, expect, it } from "vitest";

import { SanitizeError, sanitizeSvg } from "./sanitize.js";

const OK_SVG =
  '<svg width="800" height="260" viewBox="0 0 800 260" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="800" height="260" fill="#0d1117"/>' +
  '<path fill="#e6edf3" d="M0 0h10v10H0z"/>' +
  "</svg>";

describe("sanitizeSvg accepts", () => {
  it("plain satori-style output with the svg xmlns", () => {
    expect(sanitizeSvg(OK_SVG)).toBe(OK_SVG);
  });

  it("data: URI images", () => {
    const svg = OK_SVG.replace(
      "</svg>",
      '<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/></svg>',
    );
    expect(sanitizeSvg(svg)).toBe(svg);
  });

  it("#fragment references (defs/use, keyframes classes)", () => {
    const svg = OK_SVG.replace(
      "</svg>",
      '<defs><clipPath id="c"><rect width="8" height="8"/></clipPath></defs>' +
        '<use href="#c"/><style>@media (prefers-reduced-motion: no-preference){.mib-fadeIn{animation-name:mib-fadeIn}}</style></svg>',
    );
    expect(sanitizeSvg(svg)).toBe(svg);
  });

  it("the xlink namespace declaration", () => {
    const svg = OK_SVG.replace(
      'xmlns="http://www.w3.org/2000/svg"',
      'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"',
    );
    expect(sanitizeSvg(svg)).toBe(svg);
  });
});

describe("sanitizeSvg rejects", () => {
  const cases: Array<[string, string]> = [
    ["<script>", OK_SVG.replace("</svg>", "<script>alert(1)</script></svg>")],
    ["<foreignObject>", OK_SVG.replace("</svg>", '<foreignObject width="1" height="1"/></svg>')],
    ["on* attributes", OK_SVG.replace("<path ", '<path onload="alert(1)" ')],
    ["javascript: hrefs", OK_SVG.replace("</svg>", '<a href="javascript:alert(1)">x</a></svg>')],
    ["http:// image references", OK_SVG.replace("</svg>", '<image href="http://evil.example/x.png"/></svg>')],
    ["https:// beacons hidden in style url()", OK_SVG.replace("</svg>", '<style>.x{background:url(https://evil.example/px)}</style></svg>')],
    ["protocol in single quotes", OK_SVG.replace("</svg>", "<image href='https://evil.example/x.png'/></svg>")],
  ];

  it.each(cases)("%s", (_label, svg) => {
    expect(() => sanitizeSvg(svg)).toThrow(SanitizeError);
  });

  it("throws a typed error carrying a stable code", () => {
    try {
      sanitizeSvg(OK_SVG.replace("</svg>", "<script/></svg>"));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SanitizeError);
      expect((err as SanitizeError).code).toBe("UNSAFE_SVG");
    }
  });
});
