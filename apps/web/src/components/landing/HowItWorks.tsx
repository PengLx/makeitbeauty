import { GitBranch, PenTool, Plug2 } from "lucide-react";

const STEPS = [
  {
    icon: PenTool,
    title: "Design on a canvas",
    body: "Drag, snap, and style nodes with Tailwind-style utilities on a live WYSIWYG canvas. What you see is what the renderer ships.",
  },
  {
    icon: Plug2,
    title: "Bind your live data",
    body: "Drop {{github.stats.totalStars}} into any text slot, or use native stat components that read your contribution calendar directly. GitHub today; more connectors coming.",
  },
  {
    icon: GitBranch,
    title: "Deploy via a GitHub Action",
    body: "The Action renders your design and commits the SVG into your repo. Your repo stores the image — if we're ever down, your profile goes stale, never broken.",
  },
] as const;

/** Three numbered steps from blank canvas to a committed SVG. */
export function HowItWorks() {
  return (
    <section
      aria-labelledby="how-heading"
      className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8"
    >
      <h2
        id="how-heading"
        className="font-heading text-2xl font-semibold tracking-tight text-slate-100"
      >
        How it works
      </h2>
      <ol className="mt-8 grid gap-4 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-6"
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400/20 to-fuchsia-500/20 font-mono text-sm font-bold text-cyan-300 ring-1 ring-cyan-400/30"
              >
                {i + 1}
              </span>
              <step.icon aria-hidden="true" className="size-4 text-slate-400" />
            </div>
            <h3 className="font-heading text-base font-semibold text-slate-100">
              {step.title}
            </h3>
            <p className="text-sm leading-relaxed text-slate-400">
              {step.body}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
