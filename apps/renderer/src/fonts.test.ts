/**
 * Font system: built-in multi-family registry, BUILTIN_FAMILIES as the one
 * source of truth (GET /internal/fonts), unknown-family fallback, per-request
 * user fonts (parse / magic bytes / LRU / shadow protection / isolation),
 * community font isolation, and terminal-card's real-mono adoption.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_FAMILIES,
  DEFAULT_FONT_FAMILY,
  FONT_CACHE_CAP,
  FontError,
  MAX_FONT_BYTES,
  clearFontCache,
  fontCacheKeys,
  isBuiltinFamily,
  loadFontsOrExit,
  mergeFonts,
  parseFontFilename,
  parseRequestFonts,
  sniffFontFormat,
  type LoadedFont,
} from "./fonts.js";
import { createRendererServer } from "./http.js";
import { kitRegistry, parseCommunityComponent, type KitComponent } from "./kit.js";
import { render } from "./pipeline.js";
import type { Design, DesignNode, TextNode } from "./types.js";

const builtins = loadFontsOrExit();
const loraData = builtins.find((f) => f.name === "Lora" && f.weight === 400)!.data;
const jbmData = builtins.find((f) => f.name === "JetBrains Mono" && f.weight === 400)!.data;

/** A schema-valid request font entry backed by real TTF bytes. */
function requestFont(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { family: "My Face", data: loraData.toString("base64"), ...over };
}

/** Minimal TTF-magic buffer whose content varies with `seed` (distinct sha256). */
function fakeTtf(seed: number): Buffer {
  return Buffer.from([0x00, 0x01, 0x00, 0x00, seed & 0xff, (seed >> 8) & 0xff]);
}

function textDesign(fontFamily: string | undefined, text = "Ilj10O"): Design {
  const style: TextNode["style"] = { fontSize: 24, color: "#e6edf3" };
  if (fontFamily !== undefined) style.fontFamily = fontFamily;
  return {
    version: 0,
    canvas: { width: 300, height: 80, background: "#0d1117" },
    nodes: [{ id: "t", type: "text", x: 10, y: 10, w: 280, h: 40, text, style }],
  };
}

function pathData(svg: string): string[] {
  const paths = [...svg.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
  expect(paths.length).toBeGreaterThan(0); // embedFont: text always becomes paths
  return paths;
}

describe("multi-family registry (filename convention)", () => {
  it("parses {Family}-{Weight} filenames, restoring aliased family names", () => {
    expect(parseFontFilename("Inter-Regular.ttf")).toEqual({
      name: "Inter",
      weight: 400,
      style: "normal",
    });
    expect(parseFontFilename("JetBrainsMono-Bold.ttf")).toEqual({
      name: "JetBrains Mono",
      weight: 700,
      style: "normal",
    });
    expect(parseFontFilename("Lora-Regular.ttf")).toEqual({
      name: "Lora",
      weight: 400,
      style: "normal",
    });
  });

  it("loads all three built-in families at 400 and 700", () => {
    const summary = builtins.map((f) => `${f.name}/${f.weight}`).sort();
    expect(summary).toEqual([
      "Inter/400",
      "Inter/700",
      "JetBrains Mono/400",
      "JetBrains Mono/700",
      "Lora/400",
      "Lora/700",
    ]);
  });

  it("BUILTIN_FAMILIES mirrors the loaded fonts — one source of truth", () => {
    expect(BUILTIN_FAMILIES).toEqual([
      { family: "Inter", weights: [400, 700] },
      { family: "JetBrains Mono", weights: [400, 700] },
      { family: "Lora", weights: [400, 700] },
    ]);
    const loaded = new Set(builtins.map((f) => f.name));
    expect(new Set(BUILTIN_FAMILIES.map((f) => f.family))).toEqual(loaded);
  });

  it("isBuiltinFamily matches case-insensitively (CSS family matching)", () => {
    expect(isBuiltinFamily("Inter")).toBe(true);
    expect(isBuiltinFamily("inter")).toBe(true);
    expect(isBuiltinFamily("JETBRAINS MONO")).toBe(true);
    expect(isBuiltinFamily("Comic Sans")).toBe(false);
  });
});

describe("sniffFontFormat (magic bytes)", () => {
  it("recognizes TTF (0x00010000 and 'true'), OTF, WOFF and WOFF2", () => {
    expect(sniffFontFormat(fakeTtf(0))).toBe("ttf");
    expect(sniffFontFormat(Buffer.from("true0000"))).toBe("ttf");
    expect(sniffFontFormat(Buffer.from("OTTO0000"))).toBe("otf");
    expect(sniffFontFormat(Buffer.from("wOFF0000"))).toBe("woff");
    expect(sniffFontFormat(Buffer.from("wOF20000"))).toBe("woff2");
  });

  it("recognizes the real built-in files as TTF", () => {
    expect(sniffFontFormat(loraData)).toBe("ttf");
    expect(sniffFontFormat(jbmData)).toBe("ttf");
  });

  it("rejects unknown or short buffers", () => {
    expect(sniffFontFormat(Buffer.from("<svg>abc"))).toBeNull();
    expect(sniffFontFormat(Buffer.from([0x00, 0x01]))).toBeNull();
    expect(sniffFontFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe("parseRequestFonts", () => {
  beforeEach(clearFontCache);

  it("returns an empty set when fonts is omitted", () => {
    expect(parseRequestFonts(undefined)).toEqual({ fonts: [], warnings: [] });
  });

  it("parses a valid entry with defaults weight 400 / style normal", () => {
    const { fonts, warnings } = parseRequestFonts([requestFont()]);
    expect(warnings).toEqual([]);
    expect(fonts).toHaveLength(1);
    expect(fonts[0].name).toBe("My Face");
    expect(fonts[0].weight).toBe(400);
    expect(fonts[0].style).toBe("normal");
    expect(fonts[0].data.equals(loraData)).toBe(true);
  });

  it("honors explicit weight 700 and style italic", () => {
    const { fonts } = parseRequestFonts([requestFont({ weight: 700, style: "italic" })]);
    expect(fonts[0].weight).toBe(700);
    expect(fonts[0].style).toBe("italic");
  });

  it("rejects a non-array and malformed entries with precise messages", () => {
    expect(() => parseRequestFonts({})).toThrow(/must be an array/);
    expect(() => parseRequestFonts(["x"])).toThrow(/fonts\[0\]: must be an object/);
    expect(() => parseRequestFonts([requestFont({ family: "" })])).toThrow(/non-empty string/);
    expect(() => parseRequestFonts([requestFont({ family: "x".repeat(65) })])).toThrow(
      /at most 64/,
    );
    expect(() => parseRequestFonts([requestFont({ weight: 500 })])).toThrow(/400 or 700/);
    expect(() => parseRequestFonts([requestFont({ style: "oblique" })])).toThrow(
      /"normal" or "italic"/,
    );
    expect(() => parseRequestFonts([{ family: "X" }])).toThrow(/"data" must be a base64 string/);
  });

  it("names the failing item", () => {
    expect(() => parseRequestFonts([requestFont(), requestFont({ weight: 100 })])).toThrow(
      /fonts\[1\]/,
    );
  });

  it("rejects WOFF2 with a message explaining the satori limitation", () => {
    const woff2 = Buffer.from("wOF2\0\0\0\0").toString("base64");
    const err = (() => {
      try {
        parseRequestFonts([requestFont({ data: woff2 })]);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(FontError);
    expect(err!.message).toContain("WOFF2");
    expect(err!.message).toContain("satori");
    expect(err!.message).toMatch(/TTF, OTF or WOFF/);
  });

  it("rejects payloads that are not TTF/OTF/WOFF (magic bytes)", () => {
    const bogus = Buffer.from("<svg onload=alert(1)>").toString("base64");
    expect(() => parseRequestFonts([requestFont({ data: bogus })])).toThrow(/magic bytes/);
  });

  it("accepts a WOFF payload (magic bytes)", () => {
    const woff = Buffer.from("wOFF\0\0\0\0more-bytes").toString("base64");
    const { fonts } = parseRequestFonts([requestFont({ data: woff })]);
    expect(fonts).toHaveLength(1);
  });

  it("rejects fonts over the 5 MB limit", () => {
    const huge = Buffer.alloc(MAX_FONT_BYTES + 1);
    huge.writeUInt32BE(0x00010000, 0);
    expect(() => parseRequestFonts([requestFont({ data: huge.toString("base64") })])).toThrow(
      /5 MB/,
    );
  });

  it("drops a font shadowing a built-in family (any case) with a warning — the built-in wins", () => {
    for (const family of ["Inter", "inter", "JetBrains Mono", "LORA"]) {
      const { fonts, warnings } = parseRequestFonts([requestFont({ family })]);
      expect(fonts).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`"${family}" shadows a built-in family`);
      expect(warnings[0]).toContain("built-in wins");
    }
  });

  it("keeps the first of two entries claiming the same family/weight/style, with a warning", () => {
    const { fonts, warnings } = parseRequestFonts([
      requestFont(),
      requestFont({ data: jbmData.toString("base64") }),
    ]);
    expect(fonts).toHaveLength(1);
    expect(fonts[0].data.equals(loraData)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("duplicate font");
  });
});

describe("request-font LRU cache", () => {
  beforeEach(clearFontCache);

  it("caches by content hash and reuses the decoded Buffer on a hit", () => {
    const a = parseRequestFonts([requestFont({ family: "A" })]).fonts[0];
    expect(fontCacheKeys()).toHaveLength(1);
    const b = parseRequestFonts([requestFont({ family: "B" })]).fonts[0];
    expect(fontCacheKeys()).toHaveLength(1); // same content → same entry
    expect(b.data).toBe(a.data); // identical Buffer instance, not a copy
  });

  it("evicts the least-recently-used entry beyond the cap", () => {
    for (let i = 0; i < FONT_CACHE_CAP; i++) {
      parseRequestFonts([requestFont({ family: `F${i}`, data: fakeTtf(i).toString("base64") })]);
    }
    expect(fontCacheKeys()).toHaveLength(FONT_CACHE_CAP);
    const [oldest, secondOldest] = fontCacheKeys();

    // Touch the oldest so it becomes most-recent…
    parseRequestFonts([requestFont({ family: "F0", data: fakeTtf(0).toString("base64") })]);
    // …then overflow the cap: the SECOND-oldest is the LRU victim now.
    parseRequestFonts([
      requestFont({ family: "New", data: fakeTtf(FONT_CACHE_CAP).toString("base64") }),
    ]);
    const keys = fontCacheKeys();
    expect(keys).toHaveLength(FONT_CACHE_CAP);
    expect(keys).toContain(oldest);
    expect(keys).not.toContain(secondOldest);
  });
});

describe("mergeFonts", () => {
  it("returns a fresh array with built-ins first (request fonts never mutate the built-in list)", () => {
    const user: LoadedFont = { name: "My Face", data: loraData, weight: 400, style: "normal" };
    const merged = mergeFonts(builtins, [user]);
    expect(merged).toHaveLength(builtins.length + 1);
    expect(merged.slice(0, builtins.length)).toEqual(builtins);
    expect(merged[merged.length - 1]).toBe(user);
    expect(merged).not.toBe(builtins);
    expect(mergeFonts(builtins, [])).not.toBe(builtins);
    expect(builtins.some((f) => f.name === "My Face")).toBe(false);
  });
});

describe("unknown-family fallback (render)", () => {
  it("warns and falls back to Inter for an unknown design fontFamily", async () => {
    const { svg, warnings } = await render(textDesign("Comic Sans"), {}, builtins);
    expect(warnings).toEqual([
      `t: unknown font family "Comic Sans" — falling back to ${DEFAULT_FONT_FAMILY}`,
    ]);
    // The fallback IS Inter: byte-identical to an explicit Inter render.
    const inter = await render(textDesign("Inter"), {}, builtins);
    expect(inter.warnings).toEqual([]);
    expect(svg).toBe(inter.svg);
  }, 30000);

  it("renders built-in families without warnings, with genuinely different glyphs", async () => {
    const inter = await render(textDesign("Inter"), {}, builtins);
    const mono = await render(textDesign("JetBrains Mono"), {}, builtins);
    const lora = await render(textDesign("Lora"), {}, builtins);
    expect(inter.warnings).toEqual([]);
    expect(mono.warnings).toEqual([]);
    expect(lora.warnings).toEqual([]);
    expect(pathData(mono.svg)).not.toEqual(pathData(inter.svg));
    expect(pathData(lora.svg)).not.toEqual(pathData(inter.svg));
    expect(pathData(lora.svg)).not.toEqual(pathData(mono.svg));
  }, 30000);

  it("matches families case-insensitively without warnings", async () => {
    const { warnings } = await render(textDesign("jetbrains mono"), {}, builtins);
    expect(warnings).toEqual([]);
  }, 30000);
});

describe("per-request fonts (render integration)", () => {
  beforeEach(clearFontCache);

  const userFont: LoadedFont = { name: "My Face", data: loraData, weight: 400, style: "normal" };

  it("renders text in a request font, deterministically", async () => {
    const merged = mergeFonts(builtins, [userFont]);
    const a = await render(textDesign("My Face"), {}, merged);
    const b = await render(textDesign("My Face"), {}, merged);
    expect(a.warnings).toEqual([]);
    expect(a.svg).toBe(b.svg);
    // The request font actually shaped the glyphs (Lora ≠ Inter fallback)…
    const fallback = await render(textDesign("My Face"), {}, builtins);
    expect(fallback.warnings).toEqual([
      `t: unknown font family "My Face" — falling back to ${DEFAULT_FONT_FAMILY}`,
    ]);
    expect(pathData(a.svg)).not.toEqual(pathData(fallback.svg));
    // …and matches the same bytes served as a built-in (Lora).
    expect(pathData(a.svg)).toEqual(pathData((await render(textDesign("Lora"), {}, builtins)).svg));
  }, 30000);

  it("isolates concurrent requests carrying different fonts for the same family name", async () => {
    const asLora = mergeFonts(builtins, [userFont]);
    const asMono = mergeFonts(builtins, [{ ...userFont, data: jbmData }]);
    const design = textDesign("My Face");
    const [a, b, a2, b2, none] = await Promise.all([
      render(design, {}, asLora),
      render(design, {}, asMono),
      render(design, {}, asLora),
      render(design, {}, asMono),
      render(design, {}, builtins),
    ]);
    expect(a.svg).not.toBe(b.svg); // each render saw only its own font
    expect(a.svg).toBe(a2.svg); // and deterministically so
    expect(b.svg).toBe(b2.svg);
    expect(none.warnings).toHaveLength(1); // the font never leaked into the built-ins
    expect(builtins.some((f) => f.name === "My Face")).toBe(false);
  }, 30000);
});

describe("community font isolation", () => {
  function card(fontFamily?: string): KitComponent {
    const style: TextNode["style"] = { fontSize: 12 };
    if (fontFamily !== undefined) style.fontFamily = fontFamily;
    return {
      id: "ada/card@1",
      title: "Card",
      frame: { w: 100, h: 40 },
      props: { label: { type: "string", default: "hi" } },
      nodes: [
        { id: "t", type: "text", x: 0, y: 0, w: 100, h: 40, text: "{{props.label}}", style },
      ],
    };
  }

  it("accepts every built-in family", () => {
    for (const { family } of BUILTIN_FAMILIES) {
      expect(parseCommunityComponent(card(family), "definition").component.id).toBe("ada/card@1");
    }
  });

  it("accepts fragments that set no fontFamily at all", () => {
    expect(parseCommunityComponent(card(), "definition").warnings).toEqual([]);
  });

  it("rejects a non-built-in fontFamily, naming the node and the allowed families", () => {
    expect(() => parseCommunityComponent(card("My Face"), "definition")).toThrow(
      /nodes\[0\]\.style\.fontFamily "My Face" is not a built-in font family/,
    );
    expect(() => parseCommunityComponent(card("My Face"), "definition")).toThrow(
      /"Inter", "JetBrains Mono", "Lora"/,
    );
    expect(() => parseCommunityComponent(card("My Face"), "definition")).toThrow(
      /private to their owner/,
    );
  });

  it("rejects a templated fontFamily — it could smuggle a non-built-in name past publish", () => {
    expect(() => parseCommunityComponent(card("{{props.label}}"), "definition")).toThrow(
      /not a built-in font family/,
    );
  });
});

describe("terminal-card real mono", () => {
  const data = {};

  it("declares JetBrains Mono on its text nodes and drops the tracking-wide mono-fake", () => {
    const card = kitRegistry().get("kit/terminal-card")!;
    const textNodes = card.nodes.filter((n): n is TextNode => n.type === "text");
    expect(textNodes.length).toBeGreaterThan(0);
    for (const node of textNodes) {
      expect(node.style?.fontFamily).toBe("JetBrains Mono");
      expect(node.tw ?? "").not.toContain("tracking-wide");
    }
  });

  it("renders with real mono glyphs — path data differs from an Inter-forced render", async () => {
    const instance: DesignNode = {
      id: "term",
      type: "instance",
      x: 20,
      y: 20,
      w: 560,
      h: 180,
      component: "kit/terminal-card",
    };
    const design: Design = {
      version: 0,
      canvas: { width: 600, height: 220, background: "#0d1117" },
      nodes: [instance],
    };

    const a = await render(design, data, builtins);
    const b = await render(design, data, builtins);
    expect(a.warnings).toEqual([]); // JetBrains Mono is a known family
    expect(a.svg).toBe(b.svg); // determinism ×2

    // Same fragment as a community definition with fontFamily stripped →
    // Inter. Identical geometry, props and ids — only the glyphs may differ.
    const interVariant = structuredClone(kitRegistry().get("kit/terminal-card")!);
    interVariant.id = "tst/terminal@1";
    for (const node of interVariant.nodes) {
      if (node.type === "text") delete node.style?.fontFamily;
    }
    const { component } = parseCommunityComponent(interVariant, "definition");
    const interDesign: Design = {
      ...design,
      nodes: [{ ...instance, component: "tst/terminal@1" }],
    };
    const inter = await render(interDesign, data, builtins, {}, [component]);
    expect(inter.warnings).toEqual([]);
    expect(pathData(a.svg)).not.toEqual(pathData(inter.svg));
  }, 30000);
});

describe("HTTP endpoints", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createRendererServer(builtins);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  );

  function postRender(body: unknown): Promise<Response> {
    return fetch(`${base}/internal/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("GET /internal/fonts", () => {
    it("serves BUILTIN_FAMILIES — the one source of truth the API proxies", async () => {
      const res = await fetch(`${base}/internal/fonts`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        builtin: [
          { family: "Inter", weights: [400, 700] },
          { family: "JetBrains Mono", weights: [400, 700] },
          { family: "Lora", weights: [400, 700] },
        ],
      });
    });

    it("only accepts GET", async () => {
      const res = await fetch(`${base}/internal/fonts`, { method: "POST" });
      expect(res.status).toBe(405);
    });
  });

  describe("POST /internal/render with fonts[]", () => {
    it("renders using a request font without warnings", async () => {
      const res = await postRender({
        design: textDesign("My Face"),
        data: {},
        fonts: [{ family: "My Face", data: loraData.toString("base64") }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { svg: string; warnings: string[] };
      expect(body.warnings).toEqual([]);
      expect(body.svg).toContain("<path");
    }, 30000);

    it("rejects a WOFF2 font with 400 INVALID_FONT and the limitation message", async () => {
      const res = await postRender({
        design: textDesign(undefined),
        data: {},
        fonts: [{ family: "X", data: Buffer.from("wOF2\0\0\0\0").toString("base64") }],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_FONT");
      expect(body.error.message).toContain("WOFF2");
    });

    it("rejects malformed font entries with 400 INVALID_FONT", async () => {
      const res = await postRender({
        design: textDesign(undefined),
        data: {},
        fonts: [{ family: "X", data: Buffer.from("not a font").toString("base64") }],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_FONT");
      expect(body.error.message).toContain("fonts[0]");
    });

    it("warns (200) when a request font shadows a built-in — the built-in wins", async () => {
      const res = await postRender({
        design: textDesign("Inter"),
        data: {},
        fonts: [{ family: "Inter", data: loraData.toString("base64") }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { warnings: string[] };
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toContain('shadows a built-in family');
    }, 30000);
  });
});
