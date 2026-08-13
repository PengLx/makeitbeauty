import type { CSSProperties } from "react";

import { exampleStrip } from "./showcase";

/**
 * Seamless horizontal marquee of the remaining showcase renders. Plain <img>
 * tags — the animation presets baked into each SVG play natively, no JS.
 *
 * Mechanism (classic CSS marquee):
 * - The track is a flex row of SEQUENCE_COPIES pixel-identical <ul> copies of
 *   the card sequence and animates translateX(0 → -50%) linearly, forever.
 *   At -50% the second half of the track sits exactly where the first half
 *   started, so the loop restart is invisible.
 * - Gap handling: instead of a gap on the track (which would leave the last
 *   card of each half without a trailing gap and make -50% land 24px short),
 *   each <ul> copy carries `gap-6` between its own cards PLUS a matching
 *   `pr-6` after its last card. Every copy is therefore exactly
 *   N × (cardWidth + 24px) wide, the track is copies × that, and
 *   translateX(-50%) lands on a pixel-identical frame.
 * - Copies: the spec's minimal form is the sequence twice, but one sequence is
 *   only ~1632px at the `sm` card size — narrower than a 1920px viewport, so a
 *   blank hole would sweep by once per loop on common desktops. Each half is
 *   therefore the sequence repeated twice (4 copies total, halves still
 *   pixel-identical, -50% math unchanged), covering viewports up to ~3264px.
 *   Only the first copy is exposed to assistive tech; the rest are
 *   aria-hidden duplicates.
 * - prefers-reduced-motion: no animation — the strip falls back to the
 *   original static overflow-x-auto scroller (duplicate copies hidden, the
 *   original centering/padding restored via motion-reduce variants).
 * - The container is overflow-hidden while animating, so the w-max track
 *   never widens the page; nothing inside the cards is focusable, so
 *   keyboard users tab straight past the strip.
 */

/** Sequence repeats per half-track — see "Copies" above. */
const SEQUENCE_COPIES = 4;

/**
 * Loop duration, derived from content width: at the `sm` card size a half
 * track is 2 repeats × 4 cards × (384px card + 24px gap) = 3264px, and one
 * loop travels exactly that far. 3264px / 60s ≈ 54s keeps it around a calm
 * ~60px/s (slower still on mobile where cards are w-72) and inside the
 * 35–55s-per-loop band.
 */
const MARQUEE_DURATION_S = 54;

/** One pixel-identical copy of the card sequence. */
function SequenceCopy({ ariaHidden }: { ariaHidden: boolean }) {
  return (
    <ul
      aria-hidden={ariaHidden || undefined}
      className={
        // w-max + shrink-0 so every copy keeps its natural (identical) width.
        "flex w-max shrink-0 items-end gap-6 pr-6" +
        // Reduced motion shows a single static copy — hide the duplicates.
        (ariaHidden ? " motion-reduce:hidden" : "")
      }
    >
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
  );
}

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
      {/*
        Strip viewport. While animating: clips the track (no page overflow)
        and fades both edges with a mask. Hovering anywhere over it pauses
        the marquee (group/marquee → track below). Under reduced motion it
        reverts to the original scrollable strip.
      */}
      <div className="examples-marquee-strip mt-8 pb-4 [scrollbar-width:thin] motion-safe:overflow-hidden motion-reduce:overflow-x-auto motion-safe:[-webkit-mask-image:linear-gradient(to_right,transparent,black_7%,black_93%,transparent)] motion-safe:[mask-image:linear-gradient(to_right,transparent,black_7%,black_93%,transparent)]">
        <div
          className="examples-marquee-track flex w-max motion-safe:animate-[examples-marquee_var(--marquee-duration,54s)_linear_infinite] motion-reduce:mx-auto motion-reduce:px-5 sm:motion-reduce:px-8"
          style={{ "--marquee-duration": `${MARQUEE_DURATION_S}s` } as CSSProperties}
        >
          {Array.from({ length: SEQUENCE_COPIES }, (_, i) => (
            <SequenceCopy key={i} ariaHidden={i > 0} />
          ))}
        </div>
      </div>
      {/*
        Keyframes + hover-pause live here (not index.css) to keep the marquee
        fully self-contained. The pause is a plain :hover rule rather than
        Tailwind's group-hover on purpose: v4 gates hover variants behind
        @media (hover: hover), which would leave touch users with no way to
        stop the strip — with plain :hover, tapping a card pauses it too.
        Two-class specificity (0,2,0) outranks the animation shorthand (0,1,0).
      */}
      <style>{`
        @keyframes examples-marquee {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .examples-marquee-strip:hover .examples-marquee-track {
          animation-play-state: paused;
        }
      `}</style>
    </section>
  );
}
