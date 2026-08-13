/**
 * Landing-page showcase generator — every image on the public landing page is
 * REAL renderer output, produced by the same pipeline that serves /v1/preview
 * and the GitHub Action. This script renders a curated set of designs against
 * the fixture snapshot (examples/demo-data.json) and writes the SVGs to
 * apps/web/src/assets/showcase/, where Landing.tsx imports them as static
 * assets (logged-out visitors can't reach the session-gated preview API).
 *
 * Renders are deterministic (architecture.md §5) — byte-identical output for
 * identical input — so the committed SVGs only churn when a design here, the
 * kit, or the renderer changes. Regenerate with:
 *
 *   pnpm --filter @makeitbeauty/renderer exec tsx ../web/scripts/generate-showcase.ts
 *
 * (run via the renderer package so tsx and the renderer's deps resolve).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadFontsOrExit } from "../../renderer/src/fonts.js";
import { repoPath } from "../../renderer/src/paths.js";
import { render } from "../../renderer/src/pipeline.js";
import type { Design } from "../../renderer/src/types.js";
import { validateDesign } from "../../renderer/src/validate.js";

/**
 * One kit component on a transparent canvas, padded so the component's own
 * drop shadows / glows are not clipped by the SVG viewBox.
 */
function single(
  component: string,
  frame: { w: number; h: number },
  pad: number,
  props?: Record<string, string | number>,
): Design {
  return {
    version: 0,
    canvas: { width: frame.w + pad * 2, height: frame.h + pad * 2 },
    nodes: [
      {
        id: "showcase",
        type: "instance",
        x: pad,
        y: pad,
        w: frame.w,
        h: frame.h,
        component,
        ...(props ? { props } : {}),
      },
    ],
  } as Design;
}

/**
 * The full profile-card composition for the hero: several kit components
 * (declarative + native stat components) composed on one dark canvas — the
 * kind of design the editor produces for a profile README.
 */
const profileCard: Design = {
  version: 0,
  name: "Landing hero — composed profile card",
  canvas: { width: 800, height: 650, background: "#0d1117", radius: 16 },
  nodes: [
    {
      id: "header",
      type: "instance",
      x: 40,
      y: 40,
      w: 720,
      h: 120,
      component: "kit/profile-header",
      props: {
        name: "{{github.user.name}}",
        login: "{{github.user.login}}",
        followers: "{{github.user.followers}}",
      },
    },
    {
      id: "heatmap",
      type: "instance",
      x: 40,
      y: 180,
      w: 720,
      h: 140,
      component: "kit/contribution-heatmap",
      props: { label: "CONTRIBUTIONS" },
    },
    {
      id: "stars",
      type: "instance",
      x: 40,
      y: 340,
      w: 280,
      h: 140,
      component: "kit/glow-stat",
      props: {
        label: "TOTAL STARS",
        value: "{{github.stats.totalStars}}",
        caption: "across public repos",
      },
    },
    {
      id: "contributions",
      type: "instance",
      x: 340,
      y: 340,
      w: 280,
      h: 140,
      component: "kit/glow-stat",
      props: {
        label: "CONTRIBUTIONS",
        value: "{{github.stats.totalContributions}}",
        caption: "in the last year",
      },
    },
    {
      id: "languages",
      type: "instance",
      x: 40,
      y: 500,
      w: 720,
      h: 110,
      component: "kit/language-bar",
    },
  ],
} as Design;

/** name → design; file written as <name>.svg. Deterministic, stable order. */
const SHOWCASE: ReadonlyArray<[string, Design]> = [
  ["profile-card", profileCard],
  [
    "contribution-heatmap",
    single("kit/contribution-heatmap", { w: 720, h: 140 }, 12),
  ],
  [
    "glow-stat",
    single("kit/glow-stat", { w: 280, h: 140 }, 28, {
      label: "TOTAL STARS",
      value: "{{github.stats.totalStars}}",
      caption: "across public repos",
    }),
  ],
  ["terminal-card", single("kit/terminal-card", { w: 560, h: 180 }, 24)],
  ["gradient-banner", single("kit/gradient-banner", { w: 720, h: 140 }, 24)],
  [
    "progress-bar",
    single("kit/progress-bar", { w: 480, h: 72 }, 12, {
      label: "{{github.stats.topLanguage}}",
      percent: 41, // matches the fixture's topLanguages[0].percent
    }),
  ],
  [
    "profile-header",
    single("kit/profile-header", { w: 720, h: 120 }, 12, {
      name: "{{github.user.name}}",
      login: "{{github.user.login}}",
      followers: "{{github.user.followers}}",
    }),
  ],
];

const data = JSON.parse(
  readFileSync(repoPath("examples", "demo-data.json"), "utf8"),
) as Record<string, unknown>;
const fonts = loadFontsOrExit();

const outDir = fileURLToPath(new URL("../src/assets/showcase/", import.meta.url));
mkdirSync(outDir, { recursive: true });

let failed = false;
for (const [name, design] of SHOWCASE) {
  const validation = validateDesign(design);
  if (!validation.ok) {
    console.error(`${name}: schema validation failed\n  ${validation.errors.join("\n  ")}`);
    failed = true;
    continue;
  }
  const { svg, warnings } = await render(design, data, fonts);
  if (warnings.length > 0) {
    // Showcase renders must be pristine — a warning means a broken binding.
    console.error(`${name}: render produced warnings:\n  ${warnings.join("\n  ")}`);
    failed = true;
    continue;
  }
  const file = `${outDir}${name}.svg`;
  writeFileSync(file, svg);
  console.log(`wrote ${file} (${Buffer.byteLength(svg)} bytes)`);
}

if (failed) process.exit(1);
