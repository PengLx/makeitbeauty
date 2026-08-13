import { exampleStrip } from "./showcase";

/**
 * Horizontal scroll of the remaining showcase renders. Plain <img> tags —
 * the animation presets baked into each SVG play natively, no JS.
 */
export function ExamplesStrip() {
  return (
    <section
      aria-labelledby="examples-heading"
      className="border-y border-white/5 bg-[#010409]/60 py-16"
    >
      <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
        <h2
          id="examples-heading"
          className="font-heading text-2xl font-semibold tracking-tight text-slate-100"
        >
          Straight from the renderer
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">
          Kit components rendered against a fixture snapshot — animations and
          all. Sign in and they bind to <em className="not-italic text-slate-300">your</em>{" "}
          stats instead.
        </p>
      </div>
      <div className="mt-8 overflow-x-auto pb-4 [scrollbar-width:thin]">
        <ul className="mx-auto flex w-max max-w-none items-end gap-6 px-5 sm:px-8">
          {exampleStrip.map((card) => (
            <li key={card.label} className="w-72 shrink-0 sm:w-96">
              <img
                src={card.src}
                alt={card.alt}
                width={card.width}
                height={card.height}
                loading="lazy"
                className="h-auto w-full"
              />
              <p className="mt-2 text-center font-mono text-[11px] text-slate-500">
                {card.label}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
