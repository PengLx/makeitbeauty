import {
  Blocks,
  ChartNoAxesColumn,
  Eye,
  PackageOpen,
  Palette,
  Sparkles,
} from "lucide-react";

const FEATURES = [
  {
    icon: Eye,
    title: "WYSIWYG parity",
    body: "The editor canvas mirrors the renderer node for node — parity is pixel-verified, so the deployed SVG matches what you designed.",
  },
  {
    icon: Sparkles,
    title: "8 animation presets",
    body: "fadeIn, pulse, float, growX, growY, slideUp, slideLeft, blink — compiled into the SVG itself. No JavaScript, plays anywhere an image loads.",
  },
  {
    icon: Palette,
    title: "Tailwind-style styling",
    body: "Style nodes with a tw utility subset — gradients, shadows, borders, rounded corners — compiled server-side into pure SVG.",
  },
  {
    icon: Blocks,
    title: "Community components",
    body: "Publish and reuse components with immutable versions and props-only isolation — a component only ever sees the props you hand it.",
  },
  {
    icon: ChartNoAxesColumn,
    title: "Native stat components",
    body: "Contribution heatmap, activity sparkline, language bar, streak flame — generated straight from your connector data.",
  },
  {
    icon: PackageOpen,
    title: "Open source & self-hostable",
    body: "MIT licensed, with a docker compose file in the repo. Run the whole stack on your own box if you'd rather.",
  },
] as const;

/** Six feature cards — the founder's "our features are this cool" grid. */
export function FeatureGrid() {
  return (
    <section
      aria-labelledby="features-heading"
      className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-8"
    >
      <h2
        id="features-heading"
        className="font-heading text-2xl font-semibold tracking-tight text-slate-100"
      >
        Built like a design tool, deployed like CI
      </h2>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <li
            key={f.title}
            className="flex flex-col gap-2.5 rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors hover:border-white/20"
          >
            <f.icon aria-hidden="true" className="size-5 text-cyan-300" />
            <h3 className="font-heading text-[15px] font-semibold text-slate-100">
              {f.title}
            </h3>
            <p className="text-sm leading-relaxed text-slate-400">{f.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
